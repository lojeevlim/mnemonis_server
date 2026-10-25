import { describe, expect, it } from "vitest";
import { createSequentialContext, DomainError, type DomainContext } from "./context.js";
import { archiveMemory, createMemory, updateMemory } from "./memoryOps.js";
import { currentSavedRevision, listMemories, pendingRevisionMap } from "./queries.js";
import { addRelation, rejectRelationsIn, removeRelation } from "./relations.js";
import { LIMITS } from "./limits.js";
import { AGENT, USER } from "./testUtils.js";
import { normalizeTitle, parseTitlePrefix } from "./titlePrefix.js";
import {
  autoRelateTopics,
  rejectStaleTopicLinks,
  TOPIC_LINK_LABEL_PREFIX,
  TOPIC_LINK_PROCESS,
  TOPIC_LINKS_PER_CALL,
  TOPIC_LINKS_PER_PROJECT,
  topicRelator,
} from "./topicLinks.js";
import type { Actor, WorkspaceState } from "./types.js";
import { createEmptyWorkspace } from "./state.js";
import { approveAll } from "./versioning.js";

/**
 * Differential test: REFERENCE below is the straightforward (scan everything per candidate, one addRelation /
 * removeRelation per link) implementation of the topic-link rules. The optimized topicLinks.ts must produce the
 * very same relation table (ids, order, timestamps, statuses) on randomized workspaces.
 */

interface RefInfo {
  project: string | null;
  topics: string[];
  archived: boolean;
  demo: boolean;
}

const MAX_TAG_IN_LABEL = LIMITS.label - TOPIC_LINK_LABEL_PREFIX.length;
const refTopicKey = (tag: string): string => normalizeTitle(tag).slice(0, MAX_TAG_IN_LABEL);

function refInfos(state: WorkspaceState, scope: "saved" | "all", own?: { id: string; title: string; tags: string[]; archived: boolean }) {
  const out = new Map<string, RefInfo>();
  for (const m of listMemories(state, { includePending: scope === "all" })) {
    const src = own && own.id === m.id ? own : m;
    const p = parseTitlePrefix(src.title);
    out.set(m.id, {
      project: p === null ? null : normalizeTitle(p),
      topics: src.tags.map(refTopicKey).filter((t, i, a) => t !== "" && a.indexOf(t) === i),
      archived: src.archived,
      demo: m.provenance.origin === "demo",
    });
  }
  return out;
}

const refProjects = (infos: Map<string, RefInfo>): Set<string> => {
  const keys = new Set<string>();
  for (const i of infos.values()) if (!i.archived && i.project !== null) keys.add(i.project);
  return keys;
};

const isTopic = (r: { label: string; provenance: { process?: string } }): boolean =>
  r.label.startsWith(TOPIC_LINK_LABEL_PREFIX) && r.provenance.process === TOPIC_LINK_PROCESS;

function refDrop(
  state: WorkspaceState,
  ctx: DomainContext,
  actor: Actor,
  memoryId: string,
  infos: Map<string, RefInfo>,
  whose: "own" | "all",
): WorkspaceState {
  const excluded = refProjects(infos);
  let next = state;
  for (const r of Object.values(state.relations)) {
    if (!isTopic(r) || (r.status !== "saved" && r.status !== "pending")) continue;
    if (r.fromId !== memoryId && r.toId !== memoryId) continue;
    const a = infos.get(r.fromId);
    const b = infos.get(r.toId);
    const t = r.label.slice(TOPIC_LINK_LABEL_PREFIX.length);
    if (actor.kind === "user" && (!a || !b)) continue;
    if (actor.kind === "agent" && (r.status !== "pending" || (whose === "own" && r.provenance.createdBy !== actor.name))) continue;
    if (a && b && a.project !== null && b.project !== null && a.project !== b.project && !excluded.has(t) && a.topics.includes(t) && b.topics.includes(t)) {
      continue;
    }
    if (actor.kind === "user") next = removeRelation(next, { id: r.id, actor }, ctx).state;
    else next = rejectRelationsIn(next, [r.id], () => ctx.now());
  }
  return next;
}

function refRelate(state: WorkspaceState, ctx: DomainContext, actor: Actor, memoryId: string): WorkspaceState {
  const scope = actor.kind === "user" ? "saved" : "all";
  const pending = actor.kind === "agent" ? pendingRevisionMap(state)[memoryId]?.snapshot : undefined;
  const infos = refInfos(state, scope, pending ? { id: memoryId, ...pending } : undefined);
  let next = refDrop(state, ctx, actor, memoryId, infos, "own");
  const me = infos.get(memoryId);
  if (me === undefined || me.archived || me.demo || me.project === null) return next;
  const excluded = refProjects(infos);
  const exists = (a: string, b: string, l: string): boolean =>
    Object.values(next.relations).some(
      (r) => r.status !== "rejected" && r.label === l && ((r.fromId === a && r.toId === b) || (r.fromId === b && r.toId === a)),
    );
  const ordered = listMemories(state, { includePending: scope === "all" }).filter((m) => m.id !== memoryId);
  let budget = TOPIC_LINKS_PER_CALL;
  for (const t of me.topics.filter((x) => !excluded.has(x))) {
    const perProject = new Map<string, number>();
    for (const o of ordered) {
      if (budget === 0) return next;
      const info = infos.get(o.id);
      if (!info || info.archived || info.demo || info.project === null || info.project === me.project || !info.topics.includes(t)) continue;
      const n = perProject.get(info.project) ?? 0;
      if (n >= TOPIC_LINKS_PER_PROJECT) continue;
      perProject.set(info.project, n + 1);
      budget--;
      if (exists(memoryId, o.id, TOPIC_LINK_LABEL_PREFIX + t)) continue;
      try {
        next = addRelation(next, ctx, {
          fromId: memoryId,
          toId: o.id,
          label: TOPIC_LINK_LABEL_PREFIX + t,
          provenance: { origin: "process", createdBy: actor.name, process: TOPIC_LINK_PROCESS },
          actor,
        }).state;
      } catch (e) {
        if (!(e instanceof DomainError && (e.code === "duplicate_relation" || e.code === "endpoint_not_saved"))) throw e;
      }
    }
  }
  return next;
}

function refRejectStale(state: WorkspaceState, ctx: DomainContext, memoryId: string): WorkspaceState {
  return refDrop(state, ctx, { kind: "agent", name: "system" }, memoryId, refInfos(state, "all"), "all");
}

// --- seeded random workspace ---------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = ["Alpha", "Beta", "Gamma", "Delta", "Eps", "Zeta"];
const TAGS = ["stripe", "Auth", " auth ", "p1", "alpha", "db", "ci", "k8s", "ux", "beta", "x"];
// Longer than a label can carry (write-time limits cap tags at 50, so these only exist in old/imported data).
const LONG_TAGS = ["L".repeat(190), "l".repeat(186) + "Q", "l".repeat(186) + "R", "l".repeat(200)];
const BOT2: Actor = { kind: "agent", name: "bot2" };

function randomWorkspace(seed: number, size: number): { state: WorkspaceState; ctx: DomainContext; ids: string[] } {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const ctx = createSequentialContext();
  let state = createEmptyWorkspace();
  const ids: string[] = [];
  const title = (): string => (r() < 0.12 ? `plain note ${Math.floor(r() * 99)}` : r() < 0.08 ? PROJECTS[Math.floor(r() * 3)] : `${pick(PROJECTS)}: item ${Math.floor(r() * 999)}`);
  const tags = (): string[] => Array.from({ length: Math.floor(r() * 4) }, () => pick(TAGS));
  const actor = (): Actor => (r() < 0.3 ? pick([AGENT, BOT2]) : USER);
  for (let i = 0; i < size; i++) {
    const m = createMemory(state, ctx, { title: title(), tags: tags(), actor: actor(), provenance: r() < 0.05 ? { origin: "demo", createdBy: "d" } : undefined });
    state = m.state;
    ids.push(m.value.id);
  }
  for (let i = 0; i < size; i++) {
    const id = pick(ids);
    const who = actor();
    try {
      if (r() < 0.1) state = archiveMemory(state, ctx, { id, actor: who }).state;
      else state = updateMemory(state, ctx, { id, patch: r() < 0.5 ? { tags: tags() } : { title: title() }, actor: who }).state;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
    }
  }
  if (r() < 0.5) state = approveAll(state, ctx, { actor: USER, revisionIds: Object.values(state.revisions).filter((v) => v.status === "pending" && r() < 0.5).map((v) => v.id) }).state;
  // Tamper with saved tags/titles behind the links' back so stale links exist.
  for (let i = 0; i < size / 4; i++) {
    const rev = currentSavedRevision(state, pick(ids));
    if (!rev) continue;
    const snapshot = r() < 0.5 ? { ...rev.snapshot, tags: tags() } : { ...rev.snapshot, title: title() };
    state = { ...state, revisions: { ...state.revisions, [rev.id]: { ...rev, snapshot } } };
  }
  // Plant over-long tags on saved revisions (the only place they can come from), shared across projects.
  for (let i = 0; i < size / 3; i++) {
    const rev = currentSavedRevision(state, pick(ids));
    if (!rev) continue;
    const snapshot = { ...rev.snapshot, tags: [...rev.snapshot.tags, pick(LONG_TAGS)] };
    state = { ...state, revisions: { ...state.revisions, [rev.id]: { ...rev, snapshot } } };
  }
  return { state, ctx, ids };
}

const same = (x: WorkspaceState, y: WorkspaceState): void => {
  expect(JSON.stringify(x.relations)).toBe(JSON.stringify(y.relations));
};

describe("topic links: optimized implementation equals the straightforward reference", () => {
  const actors: Actor[] = [USER, AGENT, BOT2];

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`single writes on every memory, seed ${seed}`, () => {
      const { state, ids } = randomWorkspace(seed, 45);
      let withLinks = 0;
      for (const actor of actors) {
        for (const id of ids) {
          const c1 = createSequentialContext("2030-01-01T00:00:00.000Z");
          const c2 = createSequentialContext("2030-01-01T00:00:00.000Z");
          const expected = refRelate(state, c1, actor, id);
          const got = autoRelateTopics(state, c2, actor, id);
          same(got, expected);
          if (expected.relations !== state.relations) withLinks++;
        }
      }
      expect(withLinks).toBeGreaterThan(0); // the scenario actually exercises adds / drops
    });

    it(`rejectStaleTopicLinks, seed ${seed}`, () => {
      const { state, ids } = randomWorkspace(seed, 45);
      for (const id of ids) {
        const c1 = createSequentialContext("2030-01-01T00:00:00.000Z");
        const c2 = createSequentialContext("2030-01-01T00:00:00.000Z");
        same(rejectStaleTopicLinks(state, c2, id), refRejectStale(state, c1, id));
      }
    });

    it(`batched relator threads state like repeated single calls, seed ${seed}`, () => {
      const { state, ids } = randomWorkspace(seed, 45);
      const order = [...ids, ...ids.slice(0, 10)].sort((a, b) => (a.length === b.length ? (a < b ? 1 : -1) : a.length - b.length));
      const c1 = createSequentialContext("2030-01-01T00:00:00.000Z");
      const c2 = createSequentialContext("2030-01-01T00:00:00.000Z");
      let expected = state;
      for (const id of order) expected = refRelate(expected, c1, USER, id);
      let got = state;
      const relate = topicRelator(state, USER);
      for (const id of order) got = relate(got, c2, id);
      same(got, expected);
      expect(got.relations).not.toBe(state.relations);
    });
  }

  it("a second reconciliation sweep never removes a link the first one left", () => {
    const { state, ids } = randomWorkspace(11, 40);
    const ctx = createSequentialContext("2030-01-01T00:00:00.000Z");
    let s = state;
    for (const id of ids) s = autoRelateTopics(s, ctx, USER, id);
    const once = JSON.stringify(Object.values(s.relations).map((r) => [r.fromId, r.toId, r.label, r.status]));
    let t = s;
    for (const id of ids) t = autoRelateTopics(t, ctx, USER, id);
    // A second sweep may add links the first one's per-call cap skipped, but never removes a valid one.
    const kept = new Set(Object.values(t.relations).map((r) => [r.fromId, r.toId, r.label, r.status].join("|")));
    for (const r of JSON.parse(once) as string[][]) expect(kept.has(r.join("|"))).toBe(true);
  });
});
