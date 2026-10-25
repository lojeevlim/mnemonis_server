import { DomainError, type DomainContext } from "./context.js";
import type { Actor, Collection, Mutation, Relation, RelationProvenance, WorkspaceState } from "./types.js";
import { assertActor, assertRelationLimits } from "./limits.js";
import { assertSafeId, freshId, requireText, safeGet } from "./util.js";
import { currentSavedRevision, getMemory, listMemories, memoryIdsWithSaved, pendingRevisionFor } from "./queries.js";

const hasSaved = (state: WorkspaceState, memoryId: string): boolean => !!currentSavedRevision(state, memoryId);

/**
 * Per-table cache of `Object.values(relations)`. Scanning a big relation table is the hot path of topic
 * linking, and a write that only ADDS relations can hand the old list on to the new table (`[...list, ...added]`)
 * instead of re-enumerating it.
 *
 * INVARIANT: relation tables and relation objects are immutable once created. Never mutate `state.relations`
 * (or a relation in it) in place, or the cached list goes stale; always build a new table. The tests freeze every
 * state to enforce this (see relationCache.test.ts).
 *
 * Enumeration order must stay identical to `Object.values`: integer-like ids (canonical array-index keys
 * 0..2^32-2) are enumerated first in ascending order whatever their insertion order, so a write that adds one
 * does not pass the list on. Deletions and status changes build new tables with no cache entry.
 */
const relationLists = new WeakMap<object, readonly Relation[]>();

/** Same result as `Object.values(table)`, cached per table object. Do not mutate the returned array. */
export function relationValues(table: WorkspaceState["relations"]): readonly Relation[] {
  let list = relationLists.get(table);
  if (!list) {
    list = Object.values(table);
    relationLists.set(table, list);
  }
  return list;
}

const isIndexKey = (id: string): boolean => /^(0|[1-9]\d*)$/.test(id) && Number(id) <= 4294967294;

/** Records `list` as the values of the freshly built `table` (callers guarantee it equals Object.values(table)). */
function remember(table: WorkspaceState["relations"], list: readonly Relation[]): void {
  relationLists.set(table, list);
}

export interface AddRelationArgs {
  fromId: string;
  toId: string;
  label: string;
  provenance: RelationProvenance;
  id?: string;
  actor: Actor;
}

/**
 * Validates `args` and builds the new relation (shared by addRelation and addRelationsBulk, so both enforce
 * the very same rules in the very same order). `relations` is only read (id uniqueness); the caller stores it.
 */
function buildRelation(
  ctx: DomainContext,
  memories: WorkspaceState["memories"],
  relations: WorkspaceState["relations"],
  args: AddRelationArgs,
  endpointOk: (id: string, isUser: boolean) => boolean,
  isDuplicate: (fromId: string, toId: string, label: string) => boolean,
): Relation {
  assertActor(args.actor);
  if (typeof args.label !== "string") throw new DomainError("invalid_input", "label must be a string");
  const label = requireText(args.label, "label");
  assertRelationLimits(label, args.provenance);
  if (args.fromId === args.toId) throw new DomainError("invalid_input", "A memory cannot relate to itself");
  for (const id of [args.fromId, args.toId]) {
    if (!safeGet(memories, id)) throw new DomainError("memory_not_found", `Memory not found: ${id}`);
  }
  const isUser = args.actor.kind === "user";
  for (const id of [args.fromId, args.toId]) {
    if (!endpointOk(id, isUser)) {
      throw new DomainError(
        "endpoint_not_saved",
        isUser ? `Memory has not been saved yet: ${id}` : `Memory has no saved or pending version: ${id}`,
      );
    }
  }
  if (isDuplicate(args.fromId, args.toId, label)) throw new DomainError("duplicate_relation", "Relation already exists");
  if (args.id !== undefined) assertSafeId(args.id, "relation");
  const id = args.id ?? freshId(ctx, "rel", (x) => Object.hasOwn(relations, x));
  if (safeGet(relations, id)) throw new DomainError("duplicate_id", `Relation id already exists: ${id}`);
  const now = ctx.now();
  return {
    id,
    fromId: args.fromId,
    toId: args.toId,
    label,
    provenance: args.provenance,
    createdAt: now,
    status: isUser ? "saved" : "pending",
    decidedAt: isUser ? now : null,
  };
}

/**
 * Adds a relation.
 *  - user actor: saved at once; both endpoints must have a saved revision.
 *  - agent actor: PENDING until a user approves it; an endpoint may itself be a pending (never yet saved) memory.
 * Rejected relations do not block proposing the same link again.
 */
export function addRelation(state: WorkspaceState, ctx: DomainContext, args: AddRelationArgs): Mutation<Relation> {
  const existing = relationValues(state.relations);
  const rel = buildRelation(
    ctx,
    state.memories,
    state.relations,
    args,
    (id, isUser) => (isUser ? hasSaved(state, id) : !!getMemory(state, id)),
    (fromId, toId, label) =>
      existing.some(
        (r) => r.status !== "rejected" && r.fromId === fromId && r.toId === toId && r.label === label,
      ),
  );
  const relations = { ...state.relations, [rel.id]: rel };
  if (!isIndexKey(rel.id)) remember(relations, [...existing, rel]);
  return { state: { ...state, relations }, value: rel };
}

/**
 * Adds several relations in order, exactly as repeated addRelation calls would (same validation, ids,
 * timestamps and duplicate rules, each item seeing the ones added before it), but with one pass over the
 * existing data and one copy of the relation table. An item failing with a code in `tolerate` is skipped;
 * any other failure throws (and nothing is returned).
 */
export function addRelationsBulk(
  state: WorkspaceState,
  ctx: DomainContext,
  items: AddRelationArgs[],
  tolerate: ReadonlySet<string> = new Set(),
): WorkspaceState {
  if (items.length === 0) return state;
  const relations = { ...state.relations };
  const dupKey = (a: string, b: string, l: string): string => `${a}\u0000${b}\u0000${l}`;
  // Only relations leaving one of the new relations' source memories can duplicate one of them.
  const sources = new Set(items.map((i) => i.fromId));
  const dups = new Set<string>();
  for (const r of relationValues(state.relations)) {
    if (r.status !== "rejected" && sources.has(r.fromId)) dups.add(dupKey(r.fromId, r.toId, r.label));
  }
  // Endpoint checks only depend on revisions, which do not change here: index them once.
  const saved = memoryIdsWithSaved(state);
  const pending = new Set<string>();
  for (const r of Object.values(state.revisions)) if (r.status === "pending") pending.add(r.memoryId);
  const added: Relation[] = [];
  for (const args of items) {
    try {
      const rel = buildRelation(
        ctx,
        state.memories,
        relations,
        args,
        (id, isUser) => saved.has(id) || (!isUser && pending.has(id)),
        (a, b, l) => dups.has(dupKey(a, b, l)),
      );
      relations[rel.id] = rel;
      added.push(rel);
      dups.add(dupKey(rel.fromId, rel.toId, rel.label));
    } catch (e) {
      if (!(e instanceof DomainError && tolerate.has(e.code))) throw e;
    }
  }
  if (added.length === 0) return state;
  if (!added.some((r) => isIndexKey(r.id))) remember(relations, [...relationValues(state.relations), ...added]);
  return { ...state, relations };
}

/**
 * User removes a link (agents get "forbidden"). A SAVED link is hard-deleted; a pending or rejected link
 * is never deleted: it is marked rejected so the record stays. `ctx` stamps decidedAt (falls back to the
 * wall clock when omitted).
 */
export function removeRelation(
  state: WorkspaceState,
  args: { id: string; actor: Actor },
  ctx?: DomainContext,
): Mutation {
  if (!args.actor || args.actor.kind !== "user") throw new DomainError("forbidden", "Only a user can remove links");
  const rel = safeGet(state.relations, args.id);
  if (!rel) throw new DomainError("relation_not_found", `Relation not found: ${args.id}`);
  if (rel.status === "rejected") return { state, value: undefined };
  if (rel.status === "pending") {
    const next = rejectRelationsIn(state, [rel.id], () => (ctx ? ctx.now() : new Date().toISOString()));
    return { state: next, value: undefined };
  }
  const relations = { ...state.relations };
  delete relations[args.id];
  return { state: { ...state, relations }, value: undefined };
}

/**
 * Relations (optionally touching one memory). By default only SAVED relations whose BOTH endpoints
 * currently have a saved revision (a link to a memory that is pending-only or was rejected never shows).
 * `includePending` additionally lists pending (proposed) relations, whatever their endpoints.
 */
export function listRelations(
  state: WorkspaceState,
  memoryId?: string,
  opts: { includePending?: boolean } = {},
): Relation[] {
  const saved = memoryIdsWithSaved(state);
  return relationValues(state.relations).filter(
    (r) =>
      (!memoryId || r.fromId === memoryId || r.toId === memoryId) &&
      ((r.status === "saved" && saved.has(r.fromId) && saved.has(r.toId)) ||
        (opts.includePending === true && r.status === "pending")),
  );
}

export interface PendingRelation {
  relationId: string;
  fromId: string;
  toId: string;
  label: string;
  /** Who proposed it (provenance.createdBy). */
  author: string;
  provenance: RelationProvenance;
  createdAt: string;
  fromTitle: string;
  toTitle: string;
  /** True when both endpoints already have a saved revision (so it can be approved now). */
  ready: boolean;
}

/** Relations proposed by agents and waiting for review, oldest first. */
export function listPendingRelations(state: WorkspaceState): PendingRelation[] {
  return relationValues(state.relations)
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === "pending")
    .sort((a, b) => (a.r.createdAt === b.r.createdAt ? a.i - b.i : a.r.createdAt < b.r.createdAt ? -1 : 1))
    .map(({ r }) => ({
      relationId: r.id,
      fromId: r.fromId,
      toId: r.toId,
      label: r.label,
      author: r.provenance.createdBy,
      provenance: r.provenance,
      createdAt: r.createdAt,
      fromTitle: getMemory(state, r.fromId)?.title ?? r.fromId,
      toTitle: getMemory(state, r.toId)?.title ?? r.toId,
      ready: hasSaved(state, r.fromId) && hasSaved(state, r.toId),
    }));
}

/** Everything waiting for review: memory proposals plus pending relations (the Inbox badge). */
export function pendingCount(state: WorkspaceState): number {
  let n = 0;
  for (const r of Object.values(state.revisions)) if (r.status === "pending") n++;
  for (const r of relationValues(state.relations)) if (r.status === "pending") n++;
  return n;
}

function requireUser(actor: Actor): void {
  assertActor(actor);
  if (actor.kind !== "user") throw new DomainError("forbidden", "Only a user can approve or reject changes");
}

function requirePendingRelation(state: WorkspaceState, relationId: string): Relation {
  const rel = safeGet(state.relations, relationId);
  if (!rel) throw new DomainError("relation_not_found", `Relation not found: ${relationId}`);
  if (rel.status !== "pending") throw new DomainError("not_pending", "This link is not waiting for review");
  return rel;
}

/** Throws unless both endpoints of `rel` have a saved revision in `state`. */
export function requireEndpointsSaved(state: WorkspaceState, rel: Relation): void {
  if (!hasSaved(state, rel.fromId) || !hasSaved(state, rel.toId)) {
    throw new DomainError("endpoint_not_saved", "Approve the linked memories first");
  }
}

/** Marks pending relations saved (callers have already checked them). */
export function approveRelationsIn(state: WorkspaceState, ids: string[], now: () => string): WorkspaceState {
  const relations = { ...state.relations };
  for (const id of ids) {
    const stamp = now();
    relations[id] = { ...relations[id], status: "saved", decidedAt: stamp };
  }
  return { ...state, relations };
}

/** Hard-deletes relations (callers have checked they are SAVED ones a user may remove). */
export function deleteRelationsIn(state: WorkspaceState, ids: string[]): WorkspaceState {
  if (ids.length === 0) return state;
  const relations = { ...state.relations };
  for (const id of ids) delete relations[id];
  return { ...state, relations };
}

export function rejectRelationsIn(state: WorkspaceState, ids: string[], now: () => string): WorkspaceState {
  const relations = { ...state.relations };
  for (const id of ids) {
    const stamp = now();
    relations[id] = { ...relations[id], status: "rejected", decidedAt: stamp };
  }
  return { ...state, relations };
}

/** User approves a proposed link. Both linked memories must already be saved. */
export function approveRelation(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { relationId: string; actor: Actor },
): Mutation<Relation> {
  requireUser(args.actor);
  const rel = requirePendingRelation(state, args.relationId);
  requireEndpointsSaved(state, rel);
  const next = approveRelationsIn(state, [rel.id], () => ctx.now());
  return { state: next, value: next.relations[rel.id] };
}

export function rejectRelation(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { relationId: string; actor: Actor },
): Mutation<Relation> {
  requireUser(args.actor);
  const rel = requirePendingRelation(state, args.relationId);
  const next = rejectRelationsIn(state, [rel.id], () => ctx.now());
  return { state: next, value: next.relations[rel.id] };
}

/**
 * Auto-rejects the relations (pending AND saved ones) touching a memory that can never be saved: it has
 * no saved revision and no open proposal (e.g. its create was rejected). Such links are invisible anyway;
 * the records are kept as rejected.
 */
export function rejectOrphanedRelations(state: WorkspaceState, ctx: DomainContext, memoryId: string): WorkspaceState {
  if (hasSaved(state, memoryId) || pendingRevisionFor(state, memoryId)) return state;
  const ids = relationValues(state.relations)
    .filter((r) => (r.status === "pending" || r.status === "saved") && (r.fromId === memoryId || r.toId === memoryId))
    .map((r) => r.id);
  return ids.length ? rejectRelationsIn(state, ids, () => ctx.now()) : state;
}

export function createCollection(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { name: string; description?: string; id?: string },
): Mutation<Collection> {
  const name = requireText(args.name, "name");
  const col: Collection = {
    id: args.id ?? freshId(ctx, "col", (x) => Object.hasOwn(state.collections, x)),
    name,
    description: args.description ?? "",
    createdAt: ctx.now(),
  };
  assertSafeId(col.id, "collection");
  if (safeGet(state.collections, col.id)) throw new DomainError("duplicate_id", `Collection exists: ${col.id}`);
  return { state: { ...state, collections: { ...state.collections, [col.id]: col } }, value: col };
}

export function updateCollection(
  state: WorkspaceState,
  args: { id: string; name?: string; description?: string },
): Mutation<Collection> {
  const cur = safeGet(state.collections, args.id);
  if (!cur) throw new DomainError("collection_not_found", `Collection not found: ${args.id}`);
  const next: Collection = {
    ...cur,
    ...(args.name !== undefined && { name: requireText(args.name, "name") }),
    ...(args.description !== undefined && { description: args.description }),
  };
  return { state: { ...state, collections: { ...state.collections, [cur.id]: next } }, value: next };
}

/** Refuses to delete a collection any memory (saved or awaiting review) still references. */
export function deleteCollection(state: WorkspaceState, args: { id: string }): Mutation {
  if (!safeGet(state.collections, args.id)) throw new DomainError("collection_not_found", `Collection not found: ${args.id}`);
  const usedBySaved = listMemories(state, { includePending: true }).some((m) => m.collectionId === args.id);
  // A proposal still waiting for review may point at the collection too: approving it would dangle.
  const usedByProposal = Object.values(state.revisions).some(
    (r) => r.status === "pending" && r.snapshot.collectionId === args.id,
  );
  if (usedBySaved || usedByProposal) {
    throw new DomainError("collection_not_empty", "Collection still has memories");
  }
  const collections = { ...state.collections };
  delete collections[args.id];
  return { state: { ...state, collections }, value: undefined };
}
