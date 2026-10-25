import { DomainError, type DomainContext } from "./context.js";
import { listMemories, pendingRevisionMap } from "./queries.js";
import { addRelation, rejectRelationsIn, relationValues, removeRelation } from "./relations.js";
import type { Actor, WorkspaceState } from "./types.js";

export const TITLE_PREFIX_LABEL = "part of";
export const TITLE_PREFIX_PROCESS = "title-prefix";

/** Case-insensitive, whitespace-collapsed form used to compare a title with a `<project>:` prefix. */
export function normalizeTitle(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The `<project>` of a `<project>: <data>` title, or null when the title has no such prefix. */
export function parseTitlePrefix(title: string): string | null {
  const i = title.indexOf(":");
  if (i < 0) return null;
  const project = title.slice(0, i).trim();
  return project !== "" && title.slice(i + 1).trim() !== "" ? project : null;
}

const isAuto = (r: { label: string; provenance: { process?: string } }): boolean =>
  r.label === TITLE_PREFIX_LABEL && r.provenance.process === TITLE_PREFIX_PROCESS;

/** Errors that just mean "nothing to add": already linked, or an endpoint the actor cannot link yet. */
const BENIGN = new Set(["duplicate_relation", "endpoint_not_saved"]);

/** id -> title of every memory with a saved or pending revision (saved title wins, as in getMemory). */
function titleMap(state: WorkspaceState): Map<string, string> {
  return new Map(listMemories(state, { includePending: true }).map((m) => [m.id, m.title]));
}

/**
 * Keeps `<project>: <data>` memories linked (child -> parent, "part of") to every memory titled `<project>`.
 * Run after a write to `memoryId` (and, for agent writes, again when a user approves it): it links the memory
 * to its parent(s), links existing children to it (parent created after its children), and drops its stale
 * auto-links after a rename. Links are created as `actor` (pending for an agent, saved for a user). Manual
 * relations are never touched; a missing parent is skipped.
 *
 * Note: a rejected / removed auto-link does not block proposing the same link again, so a user who removed
 * one will see it re-created the next time the title of either end changes.
 */
export function autoRelate(state: WorkspaceState, ctx: DomainContext, actor: Actor, memoryId: string): WorkspaceState {
  const titles = titleMap(state);
  // What the actor just wrote: an agent's title lives in its open proposal until a user approves it.
  const own = actor.kind === "agent" ? pendingRevisionMap(state)[memoryId]?.snapshot.title : undefined;
  const titleOf = (id: string): string | undefined => (id === memoryId && own !== undefined ? own : titles.get(id));

  let next = dropStaleLinks(state, ctx, actor, memoryId, titleOf);
  const link = (fromId: string, toId: string): void => {
    try {
      next = addRelation(next, ctx, {
        fromId,
        toId,
        label: TITLE_PREFIX_LABEL,
        provenance: { origin: "process", createdBy: actor.name, process: TITLE_PREFIX_PROCESS },
        actor,
      }).state;
    } catch (e) {
      if (!(e instanceof DomainError && BENIGN.has(e.code))) throw e;
    }
  };

  const others = listMemories(state, { includePending: true }).filter((m) => m.id !== memoryId && !m.archived);
  const title = titleOf(memoryId);
  if (title === undefined) return next;

  // Child case: this memory is `<project>: ...`, link it to every memory titled `<project>`.
  const project = parseTitlePrefix(title);
  if (project !== null) {
    const key = normalizeTitle(project);
    for (const m of others) if (normalizeTitle(m.title) === key) link(memoryId, m.id);
  }
  // Parent case: link every existing `<this title>: ...` memory to this one.
  const key = normalizeTitle(title);
  for (const m of others) {
    const p = parseTitlePrefix(m.title);
    if (p !== null && normalizeTitle(p) === key) link(m.id, memoryId);
  }
  return next;
}

/**
 * After a proposal is rejected: withdraws the memory's PENDING auto-links that no longer match the titles
 * (e.g. the links an agent proposed for a rename that was rejected). Saved links are left alone.
 */
export function rejectStalePendingLinks(state: WorkspaceState, ctx: DomainContext, memoryId: string): WorkspaceState {
  const titles = titleMap(state);
  return dropStaleLinks(state, ctx, { kind: "agent", name: "system" }, memoryId, (id) => titles.get(id));
}

/**
 * Removes auto-links touching `memoryId` whose child prefix no longer matches the parent title (rename).
 * A user removes saved and pending ones; an agent cannot remove a saved link, so it only withdraws pending ones.
 */
function dropStaleLinks(
  state: WorkspaceState,
  ctx: DomainContext,
  actor: Actor,
  memoryId: string,
  titleOf: (id: string) => string | undefined,
): WorkspaceState {
  let next = state;
  for (const r of relationValues(state.relations)) {
    if (!isAuto(r) || (r.status !== "saved" && r.status !== "pending")) continue;
    if (r.fromId !== memoryId && r.toId !== memoryId) continue;
    const from = titleOf(r.fromId);
    const to = titleOf(r.toId);
    const prefix = from === undefined ? null : parseTitlePrefix(from);
    if (prefix !== null && to !== undefined && normalizeTitle(prefix) === normalizeTitle(to)) continue;
    if (actor.kind === "user") next = removeRelation(next, { id: r.id, actor }, ctx).state;
    else if (r.status === "pending") next = rejectRelationsIn(next, [r.id], () => ctx.now());
  }
  return next;
}
