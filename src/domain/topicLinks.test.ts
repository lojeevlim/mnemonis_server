import { describe, expect, it } from "vitest";
import { archiveMemory, createMemory, updateMemory } from "./memoryOps.js";
import { addRelation, listRelations, removeRelation } from "./relations.js";
import { currentSavedRevision, pendingChanges } from "./queries.js";
import { LIMITS } from "./limits.js";
import { A, AGENT, setup, USER } from "./testUtils.js";
import { autoRelateTopics, rejectStaleTopicLinks, TOPIC_LINK_LABEL_PREFIX, TOPIC_LINK_PROCESS, TOPIC_LINKS_PER_CALL, TOPIC_LINKS_PER_PROJECT } from "./topicLinks.js";
import type { Actor, WorkspaceState } from "./types.js";
import { approveAll, approveRevision, rejectRevision } from "./versioning.js";

type S = ReturnType<typeof setup>["state"];
type Ctx = ReturnType<typeof setup>["ctx"];

const rels = (s: S, id?: string) => listRelations(s, id, { includePending: true });
const topic = (s: S) => rels(s).filter((r) => r.provenance.process === TOPIC_LINK_PROCESS);
const saved = (s: S) => listRelations(s).filter((r) => r.provenance.process === TOPIC_LINK_PROCESS);
const mk = (s: S, ctx: Ctx, title: string, tags: string[] = [], actor: Actor = USER) =>
  createMemory(s, ctx, { title, tags, actor });
const statuses = (s: S) => Object.values(s.relations).filter((r) => r.provenance.process === TOPIC_LINK_PROCESS).map((r) => r.status);
const pair = (r: { fromId: string; toId: string }) => [r.fromId, r.toId];

describe("topic links", () => {
  it("links the same tag across two projects once, with the topic label", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: billing", ["stripe"]);
    const b = mk(a.state, ctx, "B: checkout", ["stripe"]);
    expect(topic(b.state)).toHaveLength(1);
    expect(topic(b.state)[0]).toMatchObject({
      fromId: b.value.id,
      toId: a.value.id,
      label: `${TOPIC_LINK_LABEL_PREFIX}stripe`,
      status: "saved",
      provenance: { origin: "process", createdBy: A, process: "topic-tag" },
    });
    // Touching the older memory (either direction) never creates a second link.
    const u = updateMemory(b.state, ctx, { id: a.value.id, patch: { tags: ["stripe", "x"] }, actor: USER });
    expect(topic(u.state)).toHaveLength(1);
  });

  it("does not link the same project, memories without a colon prefix, or project tags", () => {
    const { ctx, state } = setup();
    let s = mk(state, ctx, "A: one", ["stripe"]).state;
    s = mk(s, ctx, "A: two", ["stripe"]).state;
    s = mk(s, ctx, "plain stripe note", ["stripe"]).state;
    s = mk(s, ctx, "no data:", ["stripe"]).state;
    expect(topic(s)).toHaveLength(0);
    // `vt` is the project of a memory: tagging with it is not a topic.
    s = mk(s, ctx, "VT: run build", ["vt"]).state;
    s = mk(s, ctx, "Other: thing", ["vt"]).state;
    expect(topic(s)).toHaveLength(0);
  });

  it("compares tags case-insensitively and ignores blank tags", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["Stripe", " "]);
    const b = mk(a.state, ctx, "B: y", ["  STRIPE "]);
    expect(topic(b.state).map((r) => r.label)).toEqual(["shares topic: stripe"]);
  });

  it("caps links per (topic, other project) at the 3 most recently updated", () => {
    const { ctx, state } = setup();
    let s = state;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = mk(s, ctx, `A: item ${i}`, ["stripe"]);
      s = m.state;
      ids.push(m.value.id);
    }
    const b = mk(s, ctx, "B: new", ["stripe"]);
    expect(TOPIC_LINKS_PER_PROJECT).toBe(3);
    expect(topic(b.state).map((r) => r.toId)).toEqual([ids[4], ids[3], ids[2]]);
  });

  it("caps the total links created by one write", () => {
    const { ctx, state } = setup();
    let s = state;
    for (let p = 0; p < 8; p++) s = mk(s, ctx, `P${p}: x`, ["stripe"]).state;
    const m = mk(s, ctx, "Z: x", ["stripe"]);
    const mine = topic(m.state).filter((r) => r.fromId === m.value.id);
    expect(mine).toHaveLength(8);
    // Many projects: the cap bites.
    let t = state;
    for (let p = 0; p < TOPIC_LINKS_PER_CALL + 5; p++) t = mk(t, ctx, `Q${p}: x`, ["stripe"]).state;
    const z = mk(t, ctx, "Z: x", ["stripe"]);
    expect(topic(z.state).filter((r) => r.fromId === z.value.id)).toHaveLength(TOPIC_LINKS_PER_CALL);
  });

  it("links when a tag is added later and drops the link when it is removed", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["stripe"]);
    const b = mk(a.state, ctx, "B: y");
    expect(topic(b.state)).toHaveLength(0);
    const added = updateMemory(b.state, ctx, { id: b.value.id, patch: { tags: ["stripe"] }, actor: USER });
    expect(pair(topic(added.state)[0])).toEqual([b.value.id, a.value.id]);
    const removed = updateMemory(added.state, ctx, { id: a.value.id, patch: { tags: [] }, actor: USER });
    expect(topic(removed.state)).toHaveLength(0);
  });

  it("follows a project rename: same project drops the link, a new project links", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["stripe"]);
    const b = mk(a.state, ctx, "B: y", ["stripe"]);
    const same = updateMemory(b.state, ctx, { id: b.value.id, patch: { title: "A: y" }, actor: USER });
    expect(topic(same.state)).toHaveLength(0);
    const back = updateMemory(same.state, ctx, { id: b.value.id, patch: { title: "C: y" }, actor: USER });
    expect(topic(back.state)).toHaveLength(1);
    const plain = updateMemory(back.state, ctx, { id: b.value.id, patch: { title: "plain" }, actor: USER });
    expect(topic(plain.state)).toHaveLength(0);
  });

  it("is idempotent and links existing memories when a project memory is touched again", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["stripe"]);
    const b = mk(a.state, ctx, "B: y", ["stripe"]);
    const u = updateMemory(b.state, ctx, { id: b.value.id, patch: { title: "B: z" }, actor: USER });
    const u2 = updateMemory(u.state, ctx, { id: b.value.id, patch: { tags: ["stripe", "k"] }, actor: USER });
    expect(topic(u2.state)).toHaveLength(1);
    expect(Object.keys(u2.state.relations)).toHaveLength(1);
  });

  it("treats a link in the opposite direction as existing", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x");
    const b = mk(a.state, ctx, "B: y");
    const manualTopic = addRelation(b.state, ctx, {
      fromId: a.value.id,
      toId: b.value.id,
      label: "shares topic: stripe",
      provenance: { origin: "process", createdBy: A, process: TOPIC_LINK_PROCESS },
      actor: USER,
    });
    const t = updateMemory(manualTopic.state, ctx, { id: b.value.id, patch: { tags: ["stripe"] }, actor: USER });
    const t2 = updateMemory(t.state, ctx, { id: a.value.id, patch: { tags: ["stripe"] }, actor: USER });
    expect(topic(t2.state)).toHaveLength(1);
    expect(pair(topic(t2.state)[0])).toEqual([a.value.id, b.value.id]);
  });

  it("never touches manual relations and is not suppressed by one with another label", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["stripe"]);
    const b = mk(a.state, ctx, "B: y");
    const manual = addRelation(b.state, ctx, {
      fromId: b.value.id,
      toId: a.value.id,
      label: "see also",
      provenance: { origin: "user", createdBy: A },
      actor: USER,
    });
    const tagged = updateMemory(manual.state, ctx, { id: b.value.id, patch: { tags: ["stripe"] }, actor: USER });
    expect(rels(tagged.state).map((r) => r.label).sort()).toEqual(["see also", "shares topic: stripe"]);
    const untagged = updateMemory(tagged.state, ctx, { id: b.value.id, patch: { tags: [] }, actor: USER });
    expect(rels(untagged.state).map((r) => r.label)).toEqual(["see also"]);
    // Same label but manual provenance is not an auto link either.
    const fake = addRelation(untagged.state, ctx, {
      fromId: b.value.id,
      toId: a.value.id,
      label: "shares topic: stripe",
      provenance: { origin: "user", createdBy: A },
      actor: USER,
    });
    const again = updateMemory(fake.state, ctx, { id: b.value.id, patch: { title: "B: w" }, actor: USER });
    expect(rels(again.state)).toHaveLength(2);
  });

  it("ignores archived memories but keeps an existing link when one end is archived", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["stripe"]);
    const arch = archiveMemory(a.state, ctx, { id: a.value.id, actor: USER });
    const b = mk(arch.state, ctx, "B: y", ["stripe"]);
    expect(topic(b.state)).toHaveLength(0);
    const c = mk(state, ctx, "A: x", ["stripe"]);
    const d = mk(c.state, ctx, "B: y", ["stripe"]);
    const archived = archiveMemory(d.state, ctx, { id: c.value.id, actor: USER });
    const touched = updateMemory(archived.state, ctx, { id: d.value.id, patch: { tags: ["stripe", "k"] }, actor: USER });
    expect(topic(touched.state)).toHaveLength(1);
  });

  it("coexists with title-prefix links", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "A");
    const c = mk(p.state, ctx, "A: x", ["stripe"]);
    const b = mk(c.state, ctx, "B: y", ["stripe"]);
    expect(rels(b.state).map((r) => r.label).sort()).toEqual(["part of", "shares topic: stripe"]);
    const renamed = updateMemory(b.state, ctx, { id: c.value.id, patch: { title: "plain" }, actor: USER });
    expect(rels(renamed.state).map((r) => r.label)).toEqual([]);
  });

  it("does not link to a never-saved memory as a user, then backfills when it is approved", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["stripe"], AGENT);
    const b = mk(a.state, ctx, "B: y", ["stripe"]);
    expect(topic(b.state)).toHaveLength(0);
    const approved = approveAll(b.state, ctx, { actor: USER });
    expect(saved(approved.state).map(pair)).toEqual([[a.value.id, b.value.id]]);
  });

  describe("a tag longer than the label limit allows", () => {
    const MAX = LIMITS.label - TOPIC_LINK_LABEL_PREFIX.length;
    const LONG = "t".repeat(MAX + 30);
    // Write-time limits cap tags at 50 characters, so a longer one only exists in old/imported data: plant it.
    const retag = (s: S, id: string, tags: string[]): S => {
      const rev = currentSavedRevision(s, id)!;
      return { ...s, revisions: { ...s.revisions, [rev.id]: { ...rev, snapshot: { ...rev.snapshot, tags } } } };
    };

    it("links under the truncated label, idempotently, and still detects staleness", () => {
      const { ctx, state } = setup();
      const a = mk(state, ctx, "A: x", ["seed"]);
      const b = mk(a.state, ctx, "B: y", ["seed"]);
      let s = retag(retag(b.state, a.value.id, [LONG]), b.value.id, [LONG]);
      s = { ...s, relations: {} };
      expect(LONG.length).toBeGreaterThan(MAX);
      const once = autoRelateTopics(s, ctx, USER, b.value.id);
      expect(topic(once).map((r) => r.label)).toEqual([TOPIC_LINK_LABEL_PREFIX + LONG.slice(0, MAX)]);
      expect(topic(once)[0].label.length).toBe(LIMITS.label);
      const twice = autoRelateTopics(once, ctx, USER, b.value.id);
      expect(topic(twice)).toHaveLength(1);
      expect(autoRelateTopics(twice, ctx, USER, a.value.id).relations).toBe(twice.relations);
      // The link is still valid while both keep the tag (not treated as stale)...
      expect(rejectStaleTopicLinks(twice, ctx, b.value.id).relations).toBe(twice.relations);
      // ...and goes once one side loses it.
      const stale = retag(twice, a.value.id, []);
      expect(topic(autoRelateTopics(stale, ctx, USER, b.value.id))).toHaveLength(0);
    });
  });

  describe("agent writes", () => {
    const base = (): { s: S; ctx: Ctx; a: string; b: string } => {
      const { ctx, state } = setup();
      const a = mk(state, ctx, "A: x", ["stripe"]);
      const b = mk(a.state, ctx, "B: y");
      return { s: b.state, ctx, a: a.value.id, b: b.value.id };
    };

    it("yields pending links that approve with the memory", () => {
      const { ctx, state } = setup();
      const a = mk(state, ctx, "A: x", ["stripe"]);
      const b = mk(a.state, ctx, "B: y", ["stripe"], AGENT);
      expect(topic(b.state)).toHaveLength(1);
      expect(topic(b.state)[0]).toMatchObject({ status: "pending", provenance: { createdBy: "bot" } });
      expect(saved(b.state)).toHaveLength(0);
      const approved = approveAll(b.state, ctx, { actor: USER });
      expect(saved(approved.state)).toHaveLength(1);
      expect(topic(approved.state)).toHaveLength(1);
    });

    it("a tag change leaves saved links until approval, then reconciles (D1)", () => {
      const { s, ctx, b } = base();
      const withLink = updateMemory(s, ctx, { id: b, patch: { tags: ["stripe"] }, actor: USER });
      expect(saved(withLink.state)).toHaveLength(1);
      const removal = updateMemory(withLink.state, ctx, { id: b, patch: { tags: ["other"] }, actor: AGENT });
      expect(saved(removal.state)).toHaveLength(1); // an agent cannot remove a saved link
      const approved = approveAll(removal.state, ctx, { actor: USER });
      expect(saved(approved.state)).toEqual([]);
      const one = approveRevision(removal.state, ctx, { revisionId: pendingChanges(removal.state)[0].revisionId, actor: USER });
      expect(saved(one.state)).toEqual([]);
    });

    it("a rename to another project reconciles on approval (D2)", () => {
      const { ctx, state } = setup();
      const a = mk(state, ctx, "A: x", ["stripe"]);
      const b = mk(a.state, ctx, "B: y", ["stripe"]);
      const ren = updateMemory(b.state, ctx, { id: b.value.id, patch: { title: "A: y" }, actor: AGENT });
      expect(saved(ren.state)).toHaveLength(1);
      expect(saved(approveAll(ren.state, ctx, { actor: USER }).state)).toEqual([]);
    });

    it("an agent tag addition proposes a pending link; approval by a user saves it with the revision", () => {
      const { s, ctx, a, b } = base();
      const tagged = updateMemory(s, ctx, { id: b, patch: { tags: ["stripe"] }, actor: AGENT });
      expect(topic(tagged.state)).toHaveLength(1);
      expect(topic(tagged.state)[0]).toMatchObject({ status: "pending", fromId: b, toId: a });
      const one = approveRevision(tagged.state, ctx, { revisionId: pendingChanges(tagged.state)[0].revisionId, actor: USER });
      expect(topic(one.state).filter((r) => r.status !== "rejected")).toHaveLength(1);
      expect(saved(approveAll(one.state, ctx, { actor: USER }).state)).toHaveLength(1);
    });

    it("a rejected agent tag change withdraws the pending links it proposed", () => {
      const { s, ctx, b } = base();
      const tagged = updateMemory(s, ctx, { id: b, patch: { tags: ["stripe"] }, actor: AGENT });
      expect(topic(tagged.state).some((r) => r.status === "pending")).toBe(true);
      const rejected = rejectRevision(tagged.state, ctx, {
        revisionId: pendingChanges(tagged.state)[0].revisionId,
        actor: USER,
      });
      expect(rels(rejected.state)).toEqual([]);
    });
  });

  it("skips demo sample memories", () => {
    const { ctx, state } = setup();
    const demo = (s: WorkspaceState, title: string) =>
      createMemory(s, ctx, { title, tags: ["stripe"], provenance: { origin: "demo", createdBy: "d" }, actor: USER });
    const a = demo(state, "A: x");
    const b = demo(a.state, "B: y");
    expect(topic(b.state)).toHaveLength(0);
  });

  it("links to the 3 newest of a project even when some of them are already linked (they count against the cap)", () => {
    const { ctx, state } = setup();
    let s = state;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = mk(s, ctx, `A: item ${i}`, ["stripe"]);
      s = m.state;
      ids.push(m.value.id);
    }
    const b = mk(s, ctx, "B: new");
    const pre = addRelation(b.state, ctx, {
      fromId: b.value.id,
      toId: ids[4],
      label: "shares topic: stripe",
      provenance: { origin: "process", createdBy: A, process: TOPIC_LINK_PROCESS },
      actor: USER,
    });
    const tagged = updateMemory(pre.state, ctx, { id: b.value.id, patch: { tags: ["stripe"] }, actor: USER });
    const targets = topic(tagged.state).map((r) => r.toId);
    expect(targets).toHaveLength(3);
    expect(new Set(targets)).toEqual(new Set([ids[4], ids[3], ids[2]]));
  });

  it("approve-all with several topic memories saves every link once", () => {
    const { ctx, state } = setup();
    let s = state;
    for (const p of ["A", "B", "C", "D"]) s = mk(s, ctx, `${p}: item`, ["stripe", `only ${p}`], AGENT).state;
    expect(topic(s).every((r) => r.status === "pending")).toBe(true);
    const all = approveAll(s, ctx, { actor: USER });
    const links = saved(all.state);
    expect(links).toHaveLength(6); // every pair of the 4 projects, once
    expect(topic(all.state).filter((r) => r.status === "pending")).toEqual([]);
    expect(new Set(links.map((r) => [r.fromId, r.toId].sort().join("|"))).size).toBe(6);
  });

  describe("unapproved proposals never change saved links (F1)", () => {
    const linked = () => {
      const { ctx, state } = setup();
      const a = mk(state, ctx, "A: x", ["stripe"]);
      const b = mk(a.state, ctx, "B: y", ["stripe"]);
      expect(saved(b.state)).toHaveLength(1);
      return { ctx, s: b.state, a: a.value.id, b: b.value.id };
    };

    it("a pending agent memory titled like a project does not make the tag a project tag", () => {
      const { ctx, s, a, b } = linked();
      const junk = mk(s, ctx, "Stripe: junk", [], AGENT);
      const edited = updateMemory(junk.state, ctx, { id: a, patch: { tags: ["stripe", "k"] }, actor: USER });
      expect(saved(edited.state)).toHaveLength(1);
      // Approving an agent edit of an endpoint (the junk proposal stays pending) keeps it too.
      const agentEdit = updateMemory(edited.state, ctx, { id: b, patch: { tags: ["stripe", "z"] }, actor: AGENT });
      const rev = pendingChanges(agentEdit.state).find((c) => c.memoryId === b) as { revisionId: string };
      const approved = approveRevision(agentEdit.state, ctx, { revisionId: rev.revisionId, actor: USER });
      expect(saved(approved.state)).toHaveLength(1);
      // Rejecting the junk proposal leaves the link in place.
      const junkRev = pendingChanges(approved.state).find((c) => c.memoryId === junk.value.id) as { revisionId: string };
      const rejected = rejectRevision(approved.state, ctx, { revisionId: junkRev.revisionId, actor: USER });
      expect(saved(rejected.state)).toHaveLength(1);
      const later = updateMemory(rejected.state, ctx, { id: a, patch: { title: "A: x2" }, actor: USER });
      expect(saved(later.state)).toHaveLength(1);
    });

    it("an approved project memory DOES turn the tag into a project tag (next touch drops the link)", () => {
      const { ctx, s, a } = linked();
      const junk = mk(s, ctx, "Stripe: real", [], USER);
      const edited = updateMemory(junk.state, ctx, { id: a, patch: { tags: ["stripe", "k"] }, actor: USER });
      expect(saved(edited.state)).toEqual([]);
    });

    it("a pending-only endpoint is not judged by a user: its pending links stay", () => {
      const { ctx, state } = setup();
      const a = mk(state, ctx, "A: x", ["stripe"]);
      const p = mk(a.state, ctx, "B: y", ["stripe"], AGENT);
      expect(topic(p.state)).toHaveLength(1);
      const edited = updateMemory(p.state, ctx, { id: a.value.id, patch: { tags: ["stripe", "k"] }, actor: USER });
      expect(topic(edited.state).map((r) => r.status)).toEqual(["pending"]);
    });
  });

  describe("an agent only withdraws its own pending links (F2)", () => {
    const BOT2: Actor = { kind: "agent", name: "bot2" };
    const proposed = () => {
      const { ctx, state } = setup();
      const a = mk(state, ctx, "A: x", ["stripe"]);
      const b = mk(a.state, ctx, "B: y");
      const tagged = updateMemory(b.state, ctx, { id: b.value.id, patch: { tags: ["stripe"] }, actor: AGENT });
      expect(topic(tagged.state).map((r) => [r.status, r.provenance.createdBy])).toEqual([["pending", "bot"]]);
      return { ctx, s: tagged.state, a: a.value.id, b: b.value.id };
    };

    it("another agent's later write on the memory leaves the link pending", () => {
      const { ctx, s, b } = proposed();
      const other = updateMemory(s, ctx, { id: b, patch: { title: "B: y2" }, actor: BOT2 });
      expect(statuses(other.state)).toEqual(["pending"]);
    });

    it("the proposing agent withdraws its own link when it drops the tag again", () => {
      const { ctx, s, b } = proposed();
      const back = updateMemory(s, ctx, { id: b, patch: { tags: [] }, actor: AGENT });
      expect(statuses(back.state)).toEqual(["rejected"]);
    });

    it("rejecting a proposal still withdraws pending links whoever proposed them", () => {
      const { ctx, s, b } = proposed();
      const other = updateMemory(s, ctx, { id: b, patch: { title: "B: y2" }, actor: BOT2 });
      const rev = pendingChanges(other.state).find((c) => c.memoryId === b) as { revisionId: string };
      const rejected = rejectRevision(other.state, ctx, { revisionId: rev.revisionId, actor: USER });
      expect(statuses(rejected.state)).toEqual(["rejected"]);
    });
  });

  it("removeRelation on a topic link is respected until the next relevant write", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "A: x", ["stripe"]);
    const b = mk(a.state, ctx, "B: y", ["stripe"]);
    const removed = removeRelation(b.state, { id: topic(b.state)[0].id, actor: USER }, ctx);
    expect(topic(removed.state)).toHaveLength(0);
    const again = updateMemory(removed.state, ctx, { id: b.value.id, patch: { tags: ["stripe", "k"] }, actor: USER });
    expect(topic(again.state)).toHaveLength(1);
  });
});
