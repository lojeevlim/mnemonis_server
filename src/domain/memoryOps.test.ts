import { describe, expect, it } from "vitest";
import { archiveMemory, createMemory, restoreMemory, rollbackMemory, updateMemory } from "./memoryOps.js";
import { addRelation, createCollection, deleteCollection, listRelations, removeRelation } from "./relations.js";
import { getMemory, listMemories, memoryHistory, pendingChanges, timeline } from "./queries.js";
import { A, AGENT, seedSaved, setup, USER } from "./testUtils.js";
import { createSequentialContext } from "./context.js";
import { approveAll, approveRevision, rejectRevision } from "./versioning.js";

describe("user writes auto-save", () => {
  it("creates a memory that is saved immediately with an auto note", () => {
    const { ctx, state } = setup();
    const { state: s, value } = createMemory(state, ctx, { title: "  Hello ", tags: ["a", "a", " b "], actor: USER });
    expect(value.status).toBe("saved");
    expect(value.hasPending).toBe(false);
    expect(value.title).toBe("Hello");
    expect(value.tags).toEqual(["a", "b"]);
    expect(value.provenance).toEqual({ origin: "user", createdBy: A });
    expect(pendingChanges(s)).toHaveLength(0);
    const rev = Object.values(s.revisions)[0];
    expect(rev).toMatchObject({ status: "saved", origin: "user", note: "Created", author: A, parentRevisionId: null });
    expect(rev.savedAt).toBe(rev.decidedAt);
    expect(rev.savedAt).not.toBeNull();
  });

  it("rejects empty titles and unknown collections", () => {
    const { ctx, state } = setup();
    expect(() => createMemory(state, ctx, { title: "  ", actor: USER })).toThrow(/title/);
    expect(() => createMemory(state, ctx, { title: "x", collectionId: "nope", actor: USER })).toThrow(/Collection/);
  });

  it("allows custom memory types and refuses duplicate ids", () => {
    const { ctx, state } = setup();
    const { value, state: s } = createMemory(state, ctx, { id: "r", title: "x", type: "recipe", actor: USER });
    expect(value.type).toBe("recipe");
    expect(() => createMemory(s, ctx, { id: "r", title: "y", actor: USER })).toThrow(/exists/);
  });

  it("update appends a new saved revision chained to the previous one", () => {
    const base = seedSaved(setup().state);
    const { state, value } = updateMemory(base.state, base.ctx, { id: base.memory.id, patch: { title: "New" }, actor: USER });
    expect(value.status).toBe("saved");
    expect(value.title).toBe("New");
    const hist = memoryHistory(state, base.memory.id);
    expect(hist.map((r) => r.snapshot.title)).toEqual(["New", "Base"]);
    expect(hist[0].parentRevisionId).toBe(hist[1].id);
    expect(hist[0].note).toBe("Edited title");
    expect(hist[1].snapshot.title).toBe("Base");
  });

  it("a no-op update creates no revision", () => {
    const base = seedSaved(setup().state);
    const { state } = updateMemory(base.state, base.ctx, { id: base.memory.id, patch: { title: "Base" }, actor: USER });
    expect(state).toBe(base.state);
  });

  it("archives and restores immediately, and refuses edits while archived", () => {
    const base = seedSaved(setup().state);
    const archived = archiveMemory(base.state, base.ctx, { id: base.memory.id, actor: USER });
    expect(archived.value.archived).toBe(true);
    expect(archived.value.status).toBe("archived");
    expect(memoryHistory(archived.state, base.memory.id)[0].note).toBe("Archived");
    expect(() => updateMemory(archived.state, base.ctx, { id: base.memory.id, patch: { title: "x" }, actor: USER })).toThrow(/Restore/);
    const r = restoreMemory(archived.state, base.ctx, { id: base.memory.id, actor: USER });
    expect(r.value.status).toBe("saved");
    expect(memoryHistory(r.state, base.memory.id)[0].note).toBe("Restored");
  });

  it("treats content as inert data", () => {
    const { ctx, state } = setup();
    const evil = "<script>alert(1)</script>${process.exit()}";
    const { value } = createMemory(state, ctx, { title: "x", content: evil, actor: USER });
    expect(value.content).toBe(evil);
  });

  it("state stays JSON-safe", () => {
    const base = seedSaved(setup().state);
    expect(JSON.parse(JSON.stringify(base.state))).toEqual(base.state);
  });

  it("an explicit provenance is kept; the default follows the actor", () => {
    const { ctx, state } = setup();
    const a = createMemory(state, ctx, { title: "x", actor: AGENT }).value;
    expect(a.provenance).toEqual({ origin: "agent", createdBy: AGENT.name });
    const d = createMemory(state, ctx, { title: "x", actor: USER, provenance: { origin: "demo", createdBy: "seed" } }).value;
    expect(d.provenance).toEqual({ origin: "demo", createdBy: "seed" });
  });
});

describe("revisions are append-only", () => {
  it("only grows; existing revisions never change", () => {
    const base = seedSaved(setup().state);
    let s = base.state;
    const before = JSON.parse(JSON.stringify(s.revisions));
    for (const t of ["v1", "v2", "v3"]) {
      s = updateMemory(s, base.ctx, { id: base.memory.id, patch: { title: t }, actor: USER }).state;
    }
    expect(Object.keys(s.revisions)).toHaveLength(4);
    for (const [id, rev] of Object.entries(before)) expect(s.revisions[id]).toEqual(rev);
    expect(memoryHistory(s, base.memory.id).map((r) => r.snapshot.title)).toEqual(["v3", "v2", "v1", "Base"]);
  });
});

describe("rollback", () => {
  it("creates a NEW saved revision restoring earlier content, history intact", () => {
    const base = seedSaved(setup().state, undefined, { content: "original" });
    const origRev = base.memory.revisionId;
    const s = updateMemory(base.state, base.ctx, { id: base.memory.id, patch: { content: "changed" }, actor: USER }).state;
    const count = Object.keys(s.revisions).length;
    const rb = rollbackMemory(s, base.ctx, { memoryId: base.memory.id, toRevisionId: origRev, actor: USER });
    expect(Object.keys(rb.state.revisions)).toHaveLength(count + 1);
    expect(rb.value.content).toBe("original");
    expect(rb.value.status).toBe("saved");
    expect(rb.value.revisionId).not.toBe(origRev);
    expect(rb.state.revisions[origRev]).toEqual(s.revisions[origRev]);
    const hist = memoryHistory(rb.state, base.memory.id);
    expect(hist).toHaveLength(3);
    expect(hist[0].parentRevisionId).toBe(hist[1].id);
    expect(hist[0].note).toBe(`Rolled back to ${s.revisions[origRev].savedAt}`);
  });

  it("rejects revisions of another memory and non-saved revisions", () => {
    const a = seedSaved(setup().state, undefined, { id: "m1" });
    const b = seedSaved(a.state, a.ctx, { id: "m2" });
    expect(() => rollbackMemory(b.state, b.ctx, { memoryId: "m1", toRevisionId: b.memory.revisionId, actor: USER })).toThrow();
    const p = updateMemory(b.state, b.ctx, { id: "m1", patch: { title: "prop" }, actor: AGENT });
    const pendingId = pendingChanges(p.state)[0].revisionId;
    expect(() => rollbackMemory(p.state, b.ctx, { memoryId: "m1", toRevisionId: pendingId, actor: USER })).toThrow(/saved/);
  });

  it("restores a deleted collection reference as null", () => {
    const { ctx, state } = setup();
    let s = createCollection(state, ctx, { id: "c1", name: "C" }).state;
    const m = createMemory(s, ctx, { id: "m", title: "t", collectionId: "c1", actor: USER });
    s = updateMemory(m.state, ctx, { id: "m", patch: { collectionId: null }, actor: USER }).state;
    s = deleteCollection(s, { id: "c1" }).state;
    const rb = rollbackMemory(s, ctx, { memoryId: "m", toRevisionId: m.value.revisionId, actor: USER });
    expect(rb.value.collectionId).toBeNull();
  });

  it("rollback after approve works: undo an approved agent change", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1", content: "orig" });
    const prop = updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "agent" }, actor: AGENT }).state;
    const approved = approveRevision(prop, base.ctx, { revisionId: pendingChanges(prop)[0].revisionId, actor: USER }).state;
    expect(getMemory(approved, "m1")?.content).toBe("agent");
    const rb = rollbackMemory(approved, base.ctx, { memoryId: "m1", toRevisionId: base.memory.revisionId, actor: USER });
    expect(rb.value.content).toBe("orig");
    expect(memoryHistory(rb.state, "m1").map((r) => r.snapshot.content)).toEqual(["orig", "agent", "orig"]);
  });
});

describe("agent writes become pending proposals", () => {
  it("never saves: saved content stays, memory is flagged pending, parent is the saved revision", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1", content: "orig" });
    const { state, value } = updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "proposed" }, actor: AGENT });
    expect(value.content).toBe("orig");
    expect(value.status).toBe("pending");
    expect(value.hasPending).toBe(true);
    const [c] = pendingChanges(state);
    expect(c).toMatchObject({ memoryId: "m1", kind: "update", author: AGENT.name, origin: "agent", note: "Edited content" });
    const rev = state.revisions[c.revisionId];
    expect(rev).toMatchObject({ status: "pending", savedAt: null, decidedAt: null, parentRevisionId: base.memory.revisionId });
    expect(timeline(state)).toHaveLength(1); // nothing new saved
  });

  it("agent create is hidden from the default list and has a null parent", () => {
    const { ctx, state } = setup();
    const { state: s, value } = createMemory(state, ctx, { id: "n", title: "New", actor: AGENT });
    expect(value.status).toBe("pending");
    expect(listMemories(s)).toEqual([]);
    expect(listMemories(s, { includePending: true }).map((m) => m.id)).toEqual(["n"]);
    expect(s.revisions[pendingChanges(s)[0].revisionId].parentRevisionId).toBeNull();
    expect(pendingChanges(s)[0].kind).toBe("create");
  });

  it("agent archive is proposed, not applied", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    const r = archiveMemory(base.state, base.ctx, { id: "m1", actor: AGENT });
    expect(r.value.archived).toBe(false);
    expect(pendingChanges(r.state)[0].kind).toBe("archive");
  });

  it("same actor accumulates into one proposal; the older one is superseded", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    let s = updateMemory(base.state, base.ctx, { id: "m1", patch: { tags: ["x"] }, actor: AGENT }).state;
    s = updateMemory(s, base.ctx, { id: "m1", patch: { type: "task" }, actor: AGENT }).state;
    const pending = pendingChanges(s);
    expect(pending).toHaveLength(1);
    const snap = s.revisions[pending[0].revisionId].snapshot;
    expect(snap.tags).toEqual(["x"]);
    expect(snap.type).toBe("task");
    expect(pending[0].note).toBe("Edited type, tags");
    const statuses = Object.values(s.revisions).filter((r) => r.memoryId === "m1").map((r) => r.status);
    expect(statuses).toEqual(["saved", "superseded", "pending"]);
  });

  it("a different actor supersedes and starts from the saved content", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    let s = updateMemory(base.state, base.ctx, { id: "m1", patch: { tags: ["x"] }, actor: AGENT }).state;
    s = updateMemory(s, base.ctx, { id: "m1", patch: { type: "task" }, actor: { kind: "agent", name: "other" } }).state;
    const pending = pendingChanges(s);
    expect(pending).toHaveLength(1);
    expect(pending[0].author).toBe("other");
    expect(s.revisions[pending[0].revisionId].snapshot.tags).toEqual([]);
  });

  it("no-op agent writes create nothing; an agent can withdraw its own proposal", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1", content: "c" });
    expect(updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "c" }, actor: AGENT }).state).toBe(base.state);
    const p = updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "d" }, actor: AGENT }).state;
    expect(updateMemory(p, base.ctx, { id: "m1", patch: { content: "d" }, actor: AGENT }).state).toBe(p);
    const withdrawn = updateMemory(p, base.ctx, { id: "m1", patch: { content: "c" }, actor: AGENT }).state;
    expect(pendingChanges(withdrawn)).toHaveLength(0);
    expect(getMemory(withdrawn, "m1")?.hasPending).toBe(false);
  });

  it("a user edit supersedes an agent proposal (user wins, no conflicts)", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1", content: "orig" });
    const p = updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "agent" }, actor: AGENT }).state;
    const u = updateMemory(p, base.ctx, { id: "m1", patch: { title: "Mine" }, actor: USER });
    expect(u.value.content).toBe("orig");
    expect(u.value.title).toBe("Mine");
    expect(u.value.hasPending).toBe(false);
    expect(pendingChanges(u.state)).toHaveLength(0);
    const agentRev = Object.values(u.state.revisions).find((r) => r.origin === "agent");
    expect(agentRev?.status).toBe("superseded");
    expect(agentRev?.decidedAt).not.toBeNull();
    expect(() => approveRevision(u.state, base.ctx, { revisionId: agentRev!.id, actor: USER })).toThrow(/not waiting/);
  });

  it("at most one pending revision per memory", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    let s = base.state;
    for (const n of ["a", "b", "c"]) {
      s = updateMemory(s, base.ctx, { id: "m1", patch: { title: n }, actor: { kind: "agent", name: n } }).state;
    }
    expect(Object.values(s.revisions).filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("a user write on a never-saved agent memory is refused (not_saved): approve or reject instead", () => {
    const { ctx, state } = setup();
    const created = createMemory(state, ctx, { id: "n", title: "New", actor: AGENT });
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return undefined;
    };
    expect(code(() => updateMemory(created.state, ctx, { id: "n", patch: { title: "Mine" }, actor: USER }))).toBe("not_saved");
    expect(code(() => archiveMemory(created.state, ctx, { id: "n", actor: USER }))).toBe("not_saved");
    expect(code(() => restoreMemory(created.state, ctx, { id: "n", actor: USER }))).toBe("not_saved");
    expect(code(() => rollbackMemory(created.state, ctx, { memoryId: "n", toRevisionId: "rev_1", actor: USER }))).toBeDefined();
    // the agent can still keep refining its own proposal
    const again = updateMemory(created.state, ctx, { id: "n", patch: { title: "Agent v2" }, actor: AGENT });
    expect(again.value.title).toBe("Agent v2");
    expect(pendingChanges(again.state)).toHaveLength(1);
  });
});

describe("relations and collections", () => {
  it("adds and removes relations with validation", () => {
    const a = seedSaved(setup().state, undefined, { id: "m1" });
    const b = seedSaved(a.state, a.ctx, { id: "m2" });
    const prov = { origin: "user" as const, createdBy: A };
    const r = addRelation(b.state, b.ctx, { fromId: "m1", toId: "m2", label: "supports", provenance: prov, actor: USER });
    expect(listRelations(r.state, "m1")).toHaveLength(1);
    expect(() => addRelation(r.state, b.ctx, { fromId: "m1", toId: "m2", label: "supports", provenance: prov, actor: USER })).toThrow(/exists/);
    expect(() => addRelation(r.state, b.ctx, { fromId: "m1", toId: "zzz", label: "x", provenance: prov, actor: USER })).toThrow(/not found/);
    expect(() => addRelation(r.state, b.ctx, { fromId: "m1", toId: "m1", label: "x", provenance: prov, actor: USER })).toThrow();
    const removed = removeRelation(r.state, { id: r.value.id, actor: USER });
    expect(listRelations(removed.state)).toHaveLength(0);
    expect(() => removeRelation(removed.state, { id: r.value.id, actor: USER })).toThrow();
  });

  it("collections: delete refused while in use (including by a pending proposal)", () => {
    const ctx = createSequentialContext();
    let { state } = setup();
    const col = createCollection(state, ctx, { name: "Work" });
    state = col.state;
    state = createMemory(state, ctx, { title: "x", collectionId: col.value.id, actor: USER }).state;
    expect(listMemories(state)[0].collectionId).toBe(col.value.id);
    expect(() => deleteCollection(state, { id: col.value.id })).toThrow(/memories/);
    const empty = createCollection(state, ctx, { name: "Empty" });
    expect(Object.keys(deleteCollection(empty.state, { id: empty.value.id }).state.collections)).toHaveLength(1);
    const pendingOnly = createMemory(empty.state, ctx, { title: "p", collectionId: empty.value.id, actor: AGENT }).state;
    expect(() => deleteCollection(pendingOnly, { id: empty.value.id })).toThrow(/memories/);
  });
});

describe("title-prefix auto-relations", () => {
  const rels = (s: ReturnType<typeof setup>["state"], id?: string) => listRelations(s, id, { includePending: true });
  const mk = (s: ReturnType<typeof setup>["state"], ctx: ReturnType<typeof setup>["ctx"], title: string, actor = USER) =>
    createMemory(s, ctx, { title, actor });

  it("links a child to an existing parent (case-insensitive) as part of", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "VT");
    const c = mk(p.state, ctx, "vt : run build");
    expect(rels(c.state)).toHaveLength(1);
    expect(rels(c.state)[0]).toMatchObject({
      fromId: c.value.id,
      toId: p.value.id,
      label: "part of",
      status: "saved",
      provenance: { origin: "process", process: "title-prefix" },
    });
  });

  it("backfills children when the parent is created later", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "VT: run build");
    const b = mk(a.state, ctx, "VT: coding convention");
    expect(rels(b.state)).toHaveLength(0);
    const p = mk(b.state, ctx, "VT");
    expect(rels(p.state).map((r) => [r.fromId, r.toId]).sort()).toEqual(
      [[a.value.id, p.value.id], [b.value.id, p.value.id]].sort(),
    );
  });

  it("creates no relation without a parent, with an archived parent, or for a non-prefix title", () => {
    const { ctx, state } = setup();
    const lone = mk(state, ctx, "VT: x");
    expect(rels(lone.state)).toHaveLength(0);
    const p = mk(lone.state, ctx, "VT");
    const arch = archiveMemory(p.state, ctx, { id: p.value.id, actor: USER });
    const c = mk(arch.state, ctx, "VT: y");
    expect(rels(c.state, c.value.id)).toHaveLength(0);
    expect(rels(mk(c.state, ctx, "VT x").state, undefined).length).toBe(rels(c.state).length);
  });

  it("is idempotent when the title is touched again", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "VT");
    const c = mk(p.state, ctx, "VT: a");
    const u = updateMemory(c.state, ctx, { id: c.value.id, patch: { title: "VT: b" }, actor: USER });
    const u2 = updateMemory(u.state, ctx, { id: c.value.id, patch: { content: "x" }, actor: USER });
    expect(rels(u2.state)).toHaveLength(1);
  });

  it("moves the link on rename and removes it when the prefix goes away", () => {
    const { ctx, state } = setup();
    const a = mk(state, ctx, "VT");
    const b = mk(a.state, ctx, "XY");
    const c = mk(b.state, ctx, "VT: a");
    const toXy = updateMemory(c.state, ctx, { id: c.value.id, patch: { title: "XY: a" }, actor: USER });
    expect(rels(toXy.state).map((r) => r.toId)).toEqual([b.value.id]);
    const plain = updateMemory(toXy.state, ctx, { id: c.value.id, patch: { title: "plain" }, actor: USER });
    expect(rels(plain.state)).toHaveLength(0);
  });

  it("preserves manual relations, even between the same memories", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "VT");
    const c = mk(p.state, ctx, "VT: a");
    const manual = addRelation(c.state, ctx, {
      fromId: c.value.id,
      toId: p.value.id,
      label: "see also",
      provenance: { origin: "user", createdBy: A },
      actor: USER,
    });
    const renamed = updateMemory(manual.state, ctx, { id: c.value.id, patch: { title: "plain" }, actor: USER });
    expect(rels(renamed.state).map((r) => r.label)).toEqual(["see also"]);
  });

  it("agent save yields a pending link that approves with the memory", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "VT");
    const c = mk(p.state, ctx, "VT: a", AGENT);
    expect(rels(c.state)).toHaveLength(1);
    expect(rels(c.state)[0]).toMatchObject({ status: "pending", provenance: { createdBy: "bot" } });
    expect(listRelations(c.state)).toHaveLength(0);
    const approved = approveAll(c.state, ctx, { actor: USER });
    expect(listRelations(approved.state)).toHaveLength(1);
  });

  it("agent-proposed parent title links existing children as pending", () => {
    const { ctx, state } = setup();
    const c = mk(state, ctx, "VT: a");
    const p = mk(c.state, ctx, "VT", AGENT);
    expect(rels(p.state)).toHaveLength(1);
    expect(rels(p.state)[0]).toMatchObject({ status: "pending", fromId: c.value.id, toId: p.value.id });
  });

  const saved = (s: ReturnType<typeof setup>["state"]) => listRelations(s).map((r) => [r.fromId, r.toId]);

  it("D1: agent rename moves the saved link to the new parent on approval, without duplicates", () => {
    const { ctx, state } = setup();
    const vt = mk(state, ctx, "VT");
    const xy = mk(vt.state, ctx, "XY");
    const c = mk(xy.state, ctx, "VT: a");
    const ren = updateMemory(c.state, ctx, { id: c.value.id, patch: { title: "XY: a" }, actor: AGENT });
    const approved = approveAll(ren.state, ctx, { actor: USER });
    expect(saved(approved.state)).toEqual([[c.value.id, xy.value.id]]);
    expect(rels(approved.state)).toHaveLength(1);
    // Single-revision approval path, then the pending link is approved by the user.
    const one = approveRevision(ren.state, ctx, { revisionId: pendingChanges(ren.state)[0].revisionId, actor: USER });
    expect(rels(one.state, c.value.id).filter((r) => r.status !== "rejected")).toHaveLength(1);
  });

  it("D2a: agent renaming a parent drops the saved child link on approval", () => {
    const { ctx, state } = setup();
    const vt = mk(state, ctx, "VT");
    const c = mk(vt.state, ctx, "VT: a");
    expect(saved(c.state)).toHaveLength(1);
    const ren = updateMemory(c.state, ctx, { id: vt.value.id, patch: { title: "VT2" }, actor: AGENT });
    const approved = approveAll(ren.state, ctx, { actor: USER });
    expect(saved(approved.state)).toEqual([]);
  });

  it("D2b: user child written against an agent-created parent is backfilled when the parent is approved", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "VT", AGENT);
    const c = mk(p.state, ctx, "VT: a");
    expect(rels(c.state)).toHaveLength(0);
    const approved = approveAll(c.state, ctx, { actor: USER });
    expect(saved(approved.state)).toEqual([[c.value.id, p.value.id]]);
    // Same through the single-revision path.
    const one = approveRevision(c.state, ctx, { revisionId: pendingChanges(c.state)[0].revisionId, actor: USER });
    expect(saved(one.state)).toEqual([[c.value.id, p.value.id]]);
  });

  it("an agent child and agent parent approved together end with exactly one saved link", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "VT", AGENT);
    const c = mk(p.state, ctx, "VT: a", AGENT);
    const approved = approveAll(c.state, ctx, { actor: USER });
    expect(saved(approved.state)).toEqual([[c.value.id, p.value.id]]);
    expect(rels(approved.state).filter((r) => r.status !== "rejected")).toHaveLength(1);
  });

  it("a rejected agent rename withdraws the pending links it proposed", () => {
    const { ctx, state } = setup();
    const vt = mk(state, ctx, "VT");
    const xy = mk(vt.state, ctx, "XY");
    const c = mk(xy.state, ctx, "VT: a");
    const ren = updateMemory(c.state, ctx, { id: c.value.id, patch: { title: "XY: a" }, actor: AGENT });
    expect(rels(ren.state).some((r) => r.status === "pending")).toBe(true);
    const rejected = rejectRevision(ren.state, ctx, { revisionId: pendingChanges(ren.state)[0].revisionId, actor: USER });
    expect(rels(rejected.state).map((r) => [r.fromId, r.toId])).toEqual([[c.value.id, vt.value.id]]);
  });

  it("re-proposes a link the user removed once a title changes again (removal is not remembered)", () => {
    const { ctx, state } = setup();
    const p = mk(state, ctx, "VT");
    const c = mk(p.state, ctx, "VT: a");
    const removed = removeRelation(c.state, { id: rels(c.state)[0].id, actor: USER }, ctx);
    expect(rels(removed.state)).toHaveLength(0);
    const renamed = updateMemory(removed.state, ctx, { id: c.value.id, patch: { title: "VT: b" }, actor: USER });
    expect(saved(renamed.state)).toEqual([[c.value.id, p.value.id]]);
  });

  it("links a child to every memory with the parent title", () => {
    const { ctx, state } = setup();
    const p1 = mk(state, ctx, "VT");
    const p2 = mk(p1.state, ctx, "vt");
    const c = mk(p2.state, ctx, "VT: a");
    expect(rels(c.state).map((r) => r.toId).sort()).toEqual([p1.value.id, p2.value.id].sort());
  });
});
