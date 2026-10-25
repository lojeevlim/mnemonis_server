import { DomainError, type DomainContext } from "./context.js";
import { assertActor } from "./limits.js";
import { diffSnapshots } from "./diff.js";
import { changeKind, currentSavedRevision, getRevision, pendingChanges } from "./queries.js";
import {
  approveRelationsIn,
  rejectOrphanedRelations,
  rejectRelationsIn,
} from "./relations.js";
import { autoRelate, rejectStalePendingLinks } from "./titlePrefix.js";
import { rejectStaleTopicLinks, topicRelator } from "./topicLinks.js";
import { deepEqual } from "./util.js";
import type { Actor, MemoryFieldName, MemorySnapshot, Mutation, Revision, WorkspaceState } from "./types.js";

const hasSavedRevision = (state: WorkspaceState, memoryId: string): boolean =>
  !!currentSavedRevision(state, memoryId);

const FIELD_LABEL: Record<MemoryFieldName, string> = {
  title: "title",
  content: "content",
  type: "type",
  tags: "tags",
  collectionId: "collection",
  archived: "archived",
  metadata: "metadata",
};

/** Auto-generated note for a change: "Created", "Edited content, tags", "Archived", "Restored". */
export function describeChange(before: MemorySnapshot | undefined, after: MemorySnapshot): string {
  const kind = changeKind(before, after);
  if (kind === "create") return "Created";
  if (kind === "archive") return "Archived";
  if (kind === "restore") return "Restored";
  const fields = diffSnapshots(before, after).map((f) => FIELD_LABEL[f.field]);
  return fields.length ? `Edited ${fields.join(", ")}` : "Edited";
}

/** Approving / rejecting is a human decision: agents (and anything acting as one) are refused. */
function requireUser(actor: Actor): void {
  assertActor(actor);
  if (actor.kind !== "user") {
    throw new DomainError("forbidden", "Only a user can approve or reject changes");
  }
}

function requirePending(state: WorkspaceState, revisionId: string): Revision {
  const rev = getRevision(state, revisionId);
  if (rev.status !== "pending") throw new DomainError("not_pending", "This change is not waiting for review");
  return rev;
}

/** The proposal must still be based on the memory's current saved revision. */
function requireCurrent(state: WorkspaceState, rev: Revision): void {
  const current = currentSavedRevision(state, rev.memoryId)?.id ?? null;
  if (rev.parentRevisionId !== current) {
    throw new DomainError("proposal_outdated", "The memory changed since this proposal was made; reject it and propose again");
  }
}

/** Saved revisions are applied oldest-first so each one's parent is the previously saved one. */
function approveMany(state: WorkspaceState, ctx: DomainContext, ids: string[]): WorkspaceState {
  let next = state;
  for (const id of ids) {
    const rev = next.revisions[id];
    const stamp = ctx.now();
    // The proposal may point at a collection deleted meanwhile: never save a dangling collectionId.
    const cid = rev.snapshot.collectionId;
    const snapshot =
      cid !== null && !Object.hasOwn(next.collections, cid) ? { ...rev.snapshot, collectionId: null } : rev.snapshot;
    next = {
      ...next,
      revisions: { ...next.revisions, [id]: { ...rev, snapshot, status: "saved", savedAt: stamp, decidedAt: stamp } },
    };
  }
  return next;
}

/**
 * Re-runs the auto-relations (as the approving user) for each memory whose approved revision changed what they
 * depend on, so stale saved links drop and missing ones appear: the title-prefix one when the revision created
 * the memory or changed its title, the topic-tag one when it also changed its tags. `before` is the state prior
 * to approval (it holds the previous saved titles and tags). A pending agent link for the same pair is reused:
 * the duplicate check skips creating a second one and it is approved with the other pending links.
 * The topic index is built once for the whole batch (approving does not change it between memories).
 */
function relateApproved(before: WorkspaceState, approved: WorkspaceState, ctx: DomainContext, actor: Actor, ids: string[]): WorkspaceState {
  let next = approved;
  const relateTopics = topicRelator(approved, actor);
  for (const id of ids) {
    const memoryId = next.revisions[id].memoryId;
    const prev = currentSavedRevision(before, memoryId)?.snapshot;
    const snap = next.revisions[id].snapshot;
    if (prev?.title !== snap.title) next = autoRelate(next, ctx, actor, memoryId);
    if (!prev || prev.title !== snap.title || !deepEqual(prev.tags, snap.tags)) next = relateTopics(next, ctx, memoryId);
  }
  return next;
}

export function approveRevision(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { revisionId: string; actor: Actor },
): Mutation<Revision> {
  requireUser(args.actor);
  const rev = requirePending(state, args.revisionId);
  requireCurrent(state, rev);
  const next = relateApproved(state, approveMany(state, ctx, [rev.id]), ctx, args.actor, [rev.id]);
  return { state: next, value: next.revisions[rev.id] };
}

export function rejectRevision(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { revisionId: string; actor: Actor },
): Mutation<Revision> {
  requireUser(args.actor);
  const rev = requirePending(state, args.revisionId);
  const rejected: WorkspaceState = {
    ...state,
    revisions: { ...state.revisions, [rev.id]: { ...rev, status: "rejected", decidedAt: ctx.now() } },
  };
  // A rejected create leaves the memory never saved: its pending links can never be approved.
  const orphaned = rejectOrphanedRelations(rejected, ctx, rev.memoryId);
  const next = rejectStaleTopicLinks(rejectStalePendingLinks(orphaned, ctx, rev.memoryId), ctx, rev.memoryId);
  return { state: next, value: next.revisions[rev.id] };
}

/** Optional selection so a UI can act on exactly the items the user saw. */
export interface BulkFilter {
  /** Only these pending revisions (omit = every pending revision; [] = none). */
  revisionIds?: string[];
  /** Only these pending relations (omit = every pending relation; [] = none). */
  relationIds?: string[];
}

export interface ApproveAllResult {
  approvedRevisionIds: string[];
  approvedRelationIds: string[];
  /** Pending links left pending because an endpoint has no saved revision after this approval. */
  skippedRelationIds: string[];
  /** Filter ids that were unknown or no longer pending (ignored, not an error). */
  ignoredIds: string[];
}

export interface RejectAllResult {
  rejectedRevisionIds: string[];
  rejectedRelationIds: string[];
  ignoredIds: string[];
}

function selectPending(state: WorkspaceState, filter: BulkFilter): { revIds: string[]; relIds: string[]; ignored: string[] } {
  const pendingRevs = pendingChanges(state).map((c) => c.revisionId);
  const pendingRels = Object.values(state.relations)
    .filter((r) => r.status === "pending")
    .map((r) => r.id);
  const pick = (all: string[], wanted: string[] | undefined, ignored: string[]) => {
    if (wanted === undefined) return all;
    const set = new Set(all);
    const wantSet = new Set(wanted);
    for (const id of wantSet) if (!set.has(id)) ignored.push(id);
    return all.filter((id) => wantSet.has(id));
  };
  const ignored: string[] = [];
  return {
    revIds: pick(pendingRevs, filter.revisionIds, ignored),
    relIds: pick(pendingRels, filter.relationIds, ignored),
    ignored,
  };
}

/**
 * Approves every selected pending revision and every selected pending relation that can be approved.
 *  - atomic for real inconsistencies: an outdated proposal ("proposal_outdated") aborts everything;
 *  - a pending link whose endpoint has no saved revision once the revisions are approved (never-saveable,
 *    or its memory is outside the selection) is SKIPPED (stays pending) and reported, never blocking the rest.
 * Selection: see BulkFilter (omitted = all of that kind; unknown / stale ids are ignored and reported).
 */
export function approveAllDetailed(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { actor: Actor } & BulkFilter,
): Mutation<ApproveAllResult> {
  requireUser(args.actor);
  const { revIds, relIds, ignored } = selectPending(state, args);
  for (const id of revIds) requireCurrent(state, getRevision(state, id));
  const approved = relateApproved(state, approveMany(state, ctx, revIds), ctx, args.actor, revIds);
  const ok: string[] = [];
  const skipped: string[] = [];
  for (const id of relIds) {
    const rel = approved.relations[id];
    // Withdrawn meanwhile (a stale auto-link dropped by the re-relation above): nothing left to approve.
    if (rel.status !== "pending") {
      ignored.push(id);
      continue;
    }
    (hasSavedRevision(approved, rel.fromId) && hasSavedRevision(approved, rel.toId) ? ok : skipped).push(id);
  }
  return {
    state: approveRelationsIn(approved, ok, () => ctx.now()),
    value: { approvedRevisionIds: revIds, approvedRelationIds: ok, skippedRelationIds: skipped, ignoredIds: ignored },
  };
}

/** Like approveAllDetailed but returns only the approved REVISION ids (approved links are not listed). */
export function approveAll(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { actor: Actor } & BulkFilter,
): Mutation<string[]> {
  const r = approveAllDetailed(state, ctx, args);
  return { state: r.state, value: r.value.approvedRevisionIds };
}

/** Rejects every selected pending revision and relation (records are kept), atomically. */
export function rejectAllDetailed(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { actor: Actor } & BulkFilter,
): Mutation<RejectAllResult> {
  requireUser(args.actor);
  const { revIds, relIds, ignored } = selectPending(state, args);
  const revisions = { ...state.revisions };
  const memoryIds = new Set<string>();
  for (const id of revIds) {
    revisions[id] = { ...revisions[id], status: "rejected", decidedAt: ctx.now() };
    memoryIds.add(revisions[id].memoryId);
  }
  let next = rejectRelationsIn({ ...state, revisions }, relIds, () => ctx.now());
  for (const m of memoryIds) {
    next = rejectStalePendingLinks(rejectOrphanedRelations(next, ctx, m), ctx, m);
    next = rejectStaleTopicLinks(next, ctx, m);
  }
  return { state: next, value: { rejectedRevisionIds: revIds, rejectedRelationIds: relIds, ignoredIds: ignored } };
}

/** Like rejectAllDetailed but returns only the rejected REVISION ids. */
export function rejectAll(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { actor: Actor } & BulkFilter,
): Mutation<string[]> {
  const r = rejectAllDetailed(state, ctx, args);
  return { state: r.state, value: r.value.rejectedRevisionIds };
}
