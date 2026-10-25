import type { DomainContext } from "./context.js";
import { LIMITS } from "./limits.js";
import { currentSavedRevision, listMemories, pendingRevisionMap } from "./queries.js";
import { addRelationsBulk, deleteRelationsIn, rejectRelationsIn, relationValues } from "./relations.js";
import { normalizeTitle, parseTitlePrefix } from "./titlePrefix.js";
import type { Actor, MemorySnapshot, Relation, WorkspaceState } from "./types.js";

export const TOPIC_LINK_PROCESS = "topic-tag";
export const TOPIC_LINK_LABEL_PREFIX = "shares topic: ";

/** At most this many (most recently updated) memories of ONE other project are linked per (memory, topic). */
export const TOPIC_LINKS_PER_PROJECT = 3;
/** At most this many topic links are considered per autoRelateTopics call, so one write cannot flood the Inbox. */
export const TOPIC_LINKS_PER_CALL = 12;

const MAX_TAG_IN_LABEL = LIMITS.label - TOPIC_LINK_LABEL_PREFIX.length;

/** Errors that just mean "nothing to add": already linked, or an endpoint the actor cannot link yet. */
const BENIGN = new Set(["duplicate_relation", "endpoint_not_saved"]);

const isTopicLink = (r: { label: string; provenance: { process?: string } }): boolean =>
  r.label.startsWith(TOPIC_LINK_LABEL_PREFIX) && r.provenance.process === TOPIC_LINK_PROCESS;

/** Case-insensitive, trimmed, whitespace-collapsed tag; this is what a topic is compared (and labelled) by. */
const topicKey = (tag: string): string => normalizeTitle(tag).slice(0, MAX_TAG_IN_LABEL);

interface Info {
  /** Normalized project key (`<project>: <data>` title), or null when the title has no colon prefix. */
  project: string | null;
  /** Normalized tags, deduplicated, in tag order. */
  topics: string[];
  archived: boolean;
  /** Demo sample data: never auto-linked by topic (every demo memory shares the same tag). */
  demo: boolean;
}

const infoOf = (snap: { title: string; tags: string[]; archived: boolean }, demo: boolean): Info => {
  const p = parseTitlePrefix(snap.title);
  return {
    project: p === null ? null : normalizeTitle(p),
    topics: snap.tags.map(topicKey).filter((t, i, a) => t !== "" && a.indexOf(t) === i),
    archived: snap.archived,
    demo,
  };
};

interface Index {
  infos: Map<string, Info>;
  /** topic -> ids of the eligible candidates (not archived, not demo, with a project), most recently updated first. */
  byTopic: Map<string, string[]>;
  /**
   * Project keys: a tag equal to the `<project>` of a non-archived memory is a project tag, never a topic.
   * Only colon-title prefixes make a project key: a memory titled exactly `stripe` does not.
   */
  projects: Set<string>;
}

/**
 * One pass over the memories visible to the actor: `scope` "saved" = only memories with a saved revision (what a
 * user sees, so an unapproved agent proposal can never change which saved links are valid), "all" = saved or
 * pending (an agent's world; only pending links are ever affected by it). A memory shows its saved revision when
 * it has one, as in getMemory; `own` overrides one memory (an agent's open proposal is what the agent just wrote).
 * The candidate order is listMemories' (updatedAt desc, then id).
 */
function buildIndex(state: WorkspaceState, scope: "saved" | "all", own?: { id: string; snapshot: MemorySnapshot }): Index {
  const infos = new Map<string, Info>();
  const byTopic = new Map<string, string[]>();
  const projects = new Set<string>();
  for (const m of listMemories(state, { includePending: scope === "all" })) {
    const info = infoOf(own && own.id === m.id ? own.snapshot : m, m.provenance.origin === "demo");
    infos.set(m.id, info);
    if (info.archived || info.project === null) continue;
    projects.add(info.project);
    if (info.demo) continue;
    for (const t of info.topics) {
      const list = byTopic.get(t);
      if (list) list.push(m.id);
      else byTopic.set(t, [m.id]);
    }
  }
  return { infos, byTopic, projects };
}

/**
 * Keeps memories of DIFFERENT projects (`<project>: <data>` titles) that share a tag linked ("shares topic: <tag>").
 * Run after a write to `memoryId` (and, for agent writes, again when a user approves it): it drops its stale
 * topic links (tag removed, project changed) and links it (memory -> other) to the most recently updated memories
 * of other projects that carry the same tag. Links are created as `actor` (pending for an agent, saved for a user).
 * Manual relations are never touched. A duplicate in either direction (same label) counts as existing.
 *
 * Not eligible: archived memories, memories without a `<project>: ` prefix, project tags (a tag equal to the
 * `<project>` of a non-archived memory with a `<project>: <data>` title; a memory titled just `stripe` does not
 * make `stripe` a project tag). Fan-out is bounded: TOPIC_LINKS_PER_PROJECT per (topic, other project) and
 * TOPIC_LINKS_PER_CALL per call, in a deterministic order (updatedAt desc, then id; topics in tag order).
 * As in titlePrefix, a removed/rejected link can be proposed again by the next relevant write.
 *
 * A user's decisions (which project keys exist, which links are stale) only ever use SAVED memories: an agent's
 * unapproved proposal never makes a saved link stale. An agent only withdraws pending links it proposed itself.
 */
export function autoRelateTopics(state: WorkspaceState, ctx: DomainContext, actor: Actor, memoryId: string): WorkspaceState {
  return topicRelator(state, actor)(state, ctx, memoryId);
}

/**
 * Same as autoRelateTopics for many memories, with the memory index built once. Returns a function to call per
 * memory, in order, threading the state: `state` only has to have the same revisions as the states passed later
 * (relations may differ). Meant for a user actor approving several revisions at once; an agent actor works too
 * but rebuilds its (per-memory) index on each call.
 */
export function topicRelator(state: WorkspaceState, actor: Actor): (state: WorkspaceState, ctx: DomainContext, memoryId: string) => WorkspaceState {
  let shared: Index | undefined;
  return (current, ctx, memoryId) => relateOne(current, ctx, actor, memoryId, () => (shared ??= buildIndex(state, "saved")));
}

function relateOne(
  state: WorkspaceState,
  ctx: DomainContext,
  actor: Actor,
  memoryId: string,
  sharedIndex: () => Index,
): WorkspaceState {
  const isUser = actor.kind === "user";
  const touching: Relation[] = [];
  for (const r of relationValues(state.relations)) if (r.fromId === memoryId || r.toId === memoryId) touching.push(r);
  const hasTopicLinks = touching.some((r) => isTopicLink(r) && (r.status === "saved" || r.status === "pending"));

  // Cheap look at the written memory: most writes carry no tags or no `<project>:` prefix, so need no index.
  const pending = isUser ? undefined : pendingRevisionMap(state)[memoryId];
  const snap = pending?.snapshot ?? currentSavedRevision(state, memoryId)?.snapshot;
  const identity = Object.hasOwn(state.memories, memoryId) ? state.memories[memoryId] : undefined;
  const eligible = !!snap && !!identity && !snap.archived && identity.provenance.origin !== "demo" && parseTitlePrefix(snap.title) !== null && snap.tags.length > 0;
  if (!hasTopicLinks && !eligible) return state;

  const index = isUser ? sharedIndex() : buildIndex(state, "all", pending ? { id: memoryId, snapshot: pending.snapshot } : undefined);
  const next = hasTopicLinks ? dropStaleTopicLinks(state, ctx, actor, touching, index, isUser ? "all" : "own") : state;
  const me = index.infos.get(memoryId);
  if (!eligible || me === undefined || me.archived || me.demo || me.project === null) return next;

  // Existing (non-rejected) links of this memory, either direction: label -> other ends.
  const linked = new Set<string>();
  const current = next === state ? touching : relationValues(next.relations).filter((r) => r.fromId === memoryId || r.toId === memoryId);
  for (const r of current) if (r.status !== "rejected") linked.add(`${r.label}\u0000${r.fromId === memoryId ? r.toId : r.fromId}`);

  const items: Parameters<typeof addRelationsBulk>[2] = [];
  let budget = TOPIC_LINKS_PER_CALL;
  for (const t of me.topics) {
    if (index.projects.has(t)) continue;
    const label = TOPIC_LINK_LABEL_PREFIX + t;
    const perProject = new Map<string, number>();
    for (const id of index.byTopic.get(t) ?? []) {
      if (budget === 0) break;
      if (id === memoryId) continue;
      const info = index.infos.get(id) as Info;
      if (info.project === me.project) continue;
      const n = perProject.get(info.project as string) ?? 0;
      if (n >= TOPIC_LINKS_PER_PROJECT) continue;
      perProject.set(info.project as string, n + 1);
      budget--;
      if (linked.has(`${label}\u0000${id}`)) continue;
      items.push({
        fromId: memoryId,
        toId: id,
        label,
        provenance: { origin: "process", createdBy: actor.name, process: TOPIC_LINK_PROCESS },
        actor,
      });
    }
    if (budget === 0) break;
  }
  return addRelationsBulk(next, ctx, items, BENIGN);
}

/**
 * After a proposal is rejected: withdraws the memory's PENDING topic links that no longer qualify (e.g. the
 * links an agent proposed for a tag change that was rejected), whoever proposed them. Saved links are left alone.
 */
export function rejectStaleTopicLinks(state: WorkspaceState, ctx: DomainContext, memoryId: string): WorkspaceState {
  const touching = relationValues(state.relations).filter((r) => r.fromId === memoryId || r.toId === memoryId);
  if (!touching.some((r) => isTopicLink(r) && r.status === "pending")) return state;
  return dropStaleTopicLinks(state, ctx, { kind: "agent", name: "system" }, touching, buildIndex(state, "all"), "all");
}

/**
 * Removes topic links (`touching` = the relations of one memory) whose topic is no longer shared by two memories
 * of different projects (tag removed, project changed, or tag became a project tag). Archived endpoints do not
 * make a link stale. A user removes saved and pending ones; an agent cannot remove a saved link, so it only
 * withdraws pending ones: with `whose` "own" only those it proposed itself (provenance.createdBy), "all" any.
 * For a user the index holds saved memories only: a link to an endpoint without a saved revision is not judged.
 */
function dropStaleTopicLinks(
  state: WorkspaceState,
  ctx: DomainContext,
  actor: Actor,
  touching: Relation[],
  index: Index,
  whose: "own" | "all",
): WorkspaceState {
  const hardDelete: string[] = [];
  const withdraw: string[] = [];
  for (const r of touching) {
    if (!isTopicLink(r) || (r.status !== "saved" && r.status !== "pending")) continue;
    const a = index.infos.get(r.fromId);
    const b = index.infos.get(r.toId);
    const t = r.label.slice(TOPIC_LINK_LABEL_PREFIX.length);
    if (actor.kind === "user") {
      if (!a || !b) continue;
    } else if (r.status !== "pending" || (whose === "own" && r.provenance.createdBy !== actor.name)) continue;
    if (a && b && a.project !== null && b.project !== null && a.project !== b.project && !index.projects.has(t) && a.topics.includes(t) && b.topics.includes(t)) {
      continue;
    }
    // As removeRelation: a saved link is deleted, a pending one is kept as rejected (timestamps in this order).
    (r.status === "saved" ? hardDelete : withdraw).push(r.id);
  }
  return deleteRelationsIn(withdraw.length ? rejectRelationsIn(state, withdraw, () => ctx.now()) : state, hardDelete);
}
