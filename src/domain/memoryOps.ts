import { DomainError, type DomainContext } from "./context.js";
import { currentSavedRevision, getMemory, getRevision, pendingRevisionFor } from "./queries.js";
import type {
  Actor,
  Memory,
  MemoryProvenance,
  MemorySnapshot,
  MemoryType,
  Metadata,
  Mutation,
  Revision,
  WorkspaceState,
} from "./types.js";
import { assertActor, assertIdentityLimits, assertWithinLimits } from "./limits.js";
import { autoRelate } from "./titlePrefix.js";
import { autoRelateTopics } from "./topicLinks.js";
import { describeChange } from "./versioning.js";
import { assertSafeId, cloneJson, deepEqual, freshId, normalizeTags, requireText, safeGet } from "./util.js";

export interface CreateMemoryInput {
  /** Optional explicit id (used by seed data); must be unused. */
  id?: string;
  title: string;
  content?: string;
  type?: MemoryType;
  tags?: string[];
  collectionId?: string | null;
  source?: string;
  provenance?: MemoryProvenance;
  metadata?: Metadata;
  actor: Actor;
}

export type MemoryPatch = Partial<
  Pick<MemorySnapshot, "title" | "content" | "type" | "tags" | "collectionId" | "metadata">
>;

export function checkCollection(state: WorkspaceState, collectionId: string | null): void {
  if (collectionId !== null && !safeGet(state.collections, collectionId)) {
    throw new DomainError("collection_not_found", `Collection not found: ${collectionId}`);
  }
}

/**
 * The snapshot a write by `actor` builds on. A user always edits what they SEE (the saved
 * content). An agent continues its own open proposal (so successive tweaks accumulate); otherwise
 * it starts from the saved content (or, for a memory never saved, from its proposal). A USER write on a
 * memory that has no saved revision throws "not_saved".
 */
function baseSnapshot(state: WorkspaceState, memoryId: string, actor: Actor): MemorySnapshot {
  const saved = currentSavedRevision(state, memoryId);
  const pending = pendingRevisionFor(state, memoryId);
  if (actor.kind === "agent" && pending && pending.author === actor.name) return pending.snapshot;
  if (actor.kind === "user" && !saved && pending) {
    // The user sees nothing to edit yet: they decide on the proposal instead of silently saving agent content.
    throw new DomainError("not_saved", "This memory has not been saved yet: approve or reject its proposal instead");
  }
  const base = saved?.snapshot ?? pending?.snapshot;
  if (!base) throw new DomainError("memory_not_found", `Memory not found: ${memoryId}`);
  return base;
}

/**
 * The ONLY write path. Appends an immutable revision, never mutating existing snapshots.
 *  - user actor: saved immediately (savedAt = decidedAt = now); any open proposal is superseded.
 *  - agent actor: PENDING proposal based on the current saved revision; an older proposal for the
 *    same memory is superseded. Agents never save.
 * No-op writes create nothing (value null).
 */
export function appendRevision(
  state: WorkspaceState,
  ctx: DomainContext,
  p: { memoryId: string; snapshot: MemorySnapshot; actor: Actor; note?: string },
): Mutation<Revision | null> {
  assertActor(p.actor);
  const saved = currentSavedRevision(state, p.memoryId);
  const pending = pendingRevisionFor(state, p.memoryId);
  const hasBase = saved || pending;
  const base = hasBase ? baseSnapshot(state, p.memoryId, p.actor) : undefined;
  assertWithinLimits(p.snapshot, p.actor, base);
  if (base && deepEqual(base, p.snapshot)) return { state, value: null };

  const now = ctx.now();
  const revisions = { ...state.revisions };
  if (pending) revisions[pending.id] = { ...pending, status: "superseded", decidedAt: now };

  // An agent taking back its own proposal (snapshot == saved) just withdraws it.
  if (p.actor.kind === "agent" && saved && deepEqual(saved.snapshot, p.snapshot)) {
    return { state: { ...state, revisions }, value: null };
  }

  const isUser = p.actor.kind === "user";
  const rev: Revision = {
    id: freshId(ctx, "rev", (id) => Object.hasOwn(state.revisions, id)),
    memoryId: p.memoryId,
    snapshot: p.snapshot,
    parentRevisionId: saved?.id ?? null,
    createdAt: now,
    author: p.actor.name,
    origin: isUser ? "user" : "agent",
    status: isUser ? "saved" : "pending",
    // "Created" until a first revision is saved, even when an agent keeps editing its own pending create.
    note: p.note ?? describeChange(saved?.snapshot, p.snapshot),
    savedAt: isUser ? now : null,
    decidedAt: isUser ? now : null,
  };
  revisions[rev.id] = rev;
  return { state: { ...state, revisions }, value: rev };
}

const view = (state: WorkspaceState, id: string): Memory => getMemory(state, id) as Memory;

export function createMemory(
  state: WorkspaceState,
  ctx: DomainContext,
  input: CreateMemoryInput,
): Mutation<Memory> {
  assertActor(input.actor);
  const title = requireText(input.title, "title");
  const collectionId = input.collectionId ?? null;
  checkCollection(state, collectionId);
  const id = input.id ?? freshId(ctx, "mem", (x) => Object.hasOwn(state.memories, x));
  assertSafeId(id, "memory");
  if (safeGet(state.memories, id)) throw new DomainError("duplicate_id", `Memory id already exists: ${id}`);
  const createdAt = ctx.now();
  const identity = {
    id,
    createdAt,
    source: input.source ?? "manual",
    provenance: input.provenance ?? { origin: input.actor.kind, createdBy: input.actor.name },
  };
  const snapshot: MemorySnapshot = {
    title,
    content: input.content ?? "",
    type: requireText(input.type ?? "fact", "type"),
    tags: normalizeTags(input.tags),
    collectionId,
    archived: false,
    metadata: cloneJson(input.metadata ?? {}),
  };
  assertIdentityLimits(identity);
  const withIdentity: WorkspaceState = { ...state, memories: { ...state.memories, [id]: identity } };
  const { state: appended } = appendRevision(withIdentity, ctx, { memoryId: id, snapshot, actor: input.actor });
  const next = autoRelateTopics(autoRelate(appended, ctx, input.actor, id), ctx, input.actor, id);
  return { state: next, value: view(next, id) };
}

export function updateMemory(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { id: string; patch: MemoryPatch; actor: Actor },
): Mutation<Memory> {
  assertActor(args.actor);
  const before = baseSnapshot(state, args.id, args.actor);
  if (before.archived) throw new DomainError("memory_archived", "Restore the memory before editing it");
  const { patch } = args;
  const snapshot: MemorySnapshot = {
    ...before,
    ...(patch.title !== undefined && { title: requireText(patch.title, "title") }),
    ...(patch.content !== undefined && { content: patch.content }),
    ...(patch.type !== undefined && { type: requireText(patch.type, "type") }),
    ...(patch.tags !== undefined && { tags: normalizeTags(patch.tags) }),
    ...(patch.collectionId !== undefined && { collectionId: patch.collectionId }),
    ...(patch.metadata !== undefined && { metadata: cloneJson(patch.metadata) }),
  };
  checkCollection(state, snapshot.collectionId);
  const { state: appended } = appendRevision(state, ctx, { memoryId: args.id, snapshot, actor: args.actor });
  const titleChanged = snapshot.title !== before.title;
  const tagsChanged = !deepEqual(snapshot.tags, before.tags);
  let next = titleChanged ? autoRelate(appended, ctx, args.actor, args.id) : appended;
  if (titleChanged || tagsChanged) next = autoRelateTopics(next, ctx, args.actor, args.id);
  return { state: next, value: view(next, args.id) };
}

function setArchived(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { id: string; actor: Actor },
  archived: boolean,
): Mutation<Memory> {
  assertActor(args.actor);
  const before = baseSnapshot(state, args.id, args.actor);
  const { state: next } = appendRevision(state, ctx, {
    memoryId: args.id,
    snapshot: { ...before, archived },
    actor: args.actor,
  });
  return { state: next, value: view(next, args.id) };
}

/** Archive = soft delete (nothing is ever removed). A user archives immediately; an agent proposes it. */
export const archiveMemory = (
  state: WorkspaceState,
  ctx: DomainContext,
  args: { id: string; actor: Actor },
) => setArchived(state, ctx, args, true);

export const restoreMemory = (
  state: WorkspaceState,
  ctx: DomainContext,
  args: { id: string; actor: Actor },
) => setArchived(state, ctx, args, false);

/**
 * Rollback = append a NEW revision restoring an earlier SAVED revision's snapshot (saved at once
 * for a user, proposed for an agent). History is never rewritten.
 */
export function rollbackMemory(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { memoryId: string; toRevisionId: string; actor: Actor },
): Mutation<Memory> {
  assertActor(args.actor);
  const target = getRevision(state, args.toRevisionId);
  if (target.memoryId !== args.memoryId) {
    throw new DomainError("invalid_input", "Revision does not belong to this memory");
  }
  if (target.status !== "saved") throw new DomainError("invalid_input", "Only a saved version can be rolled back to");
  baseSnapshot(state, args.memoryId, args.actor); // existence check
  const snapshot = cloneJson(target.snapshot);
  if (snapshot.collectionId !== null && !safeGet(state.collections, snapshot.collectionId)) {
    snapshot.collectionId = null;
  }
  const { state: next } = appendRevision(state, ctx, {
    memoryId: args.memoryId,
    snapshot,
    actor: args.actor,
    note: `Rolled back to ${target.savedAt}`,
  });
  return { state: next, value: view(next, args.memoryId) };
}
