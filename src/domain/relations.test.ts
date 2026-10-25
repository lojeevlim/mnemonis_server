import { describe, expect, it } from "vitest";
import { createSequentialContext } from "./context.js";
import { createMemory } from "./memoryOps.js";
import { addRelation, addRelationsBulk, type AddRelationArgs } from "./relations.js";
import { setup, USER } from "./testUtils.js";

function world() {
  const { ctx, state } = setup();
  let s = state;
  const ids: string[] = [];
  for (const title of ["a", "b", "c", "d", "e"]) {
    const m = createMemory(s, ctx, { title, actor: USER });
    s = m.state;
    ids.push(m.value.id);
  }
  return { s, ids };
}

const prov = { origin: "user", createdBy: "tester" } as const;

describe("relation table order with integer-like ids", () => {
  it("enumerates integer-like ids first (ascending), then the rest in insertion order", () => {
    const { s, ids } = world();
    const ctx = createSequentialContext();
    let state = s;
    for (const [i, id] of ["5", "x1", "0", "y2", "3"].entries()) {
      state = addRelation(state, ctx, { fromId: ids[0], toId: ids[1], label: `l${i}`, provenance: prov, id, actor: USER }).state;
    }
    expect(Object.values(state.relations).map((r) => r.id)).toEqual(["0", "3", "5", "x1", "y2"]);
    expect(Object.keys(state.relations)).toEqual(["0", "3", "5", "x1", "y2"]);
  });

  it("addRelationsBulk equals sequential addRelation, including integer-like ids", () => {
    const { s, ids } = world();
    const items: AddRelationArgs[] = [
      { fromId: ids[0], toId: ids[1], label: "one", provenance: prov, id: "5", actor: USER },
      { fromId: ids[0], toId: ids[2], label: "two", provenance: prov, actor: USER },
      { fromId: ids[1], toId: ids[2], label: "three", provenance: prov, id: "0", actor: USER },
      { fromId: ids[2], toId: ids[3], label: "four", provenance: prov, id: "x9", actor: USER },
      { fromId: ids[3], toId: ids[4], label: "five", provenance: prov, id: "12", actor: USER },
    ];
    const c1 = createSequentialContext("2030-01-01T00:00:00.000Z");
    const c2 = createSequentialContext("2030-01-01T00:00:00.000Z");
    let seq = s;
    for (const it of items) seq = addRelation(seq, c1, it).state;
    const bulk = addRelationsBulk(s, c2, items);
    expect(JSON.stringify(bulk.relations)).toBe(JSON.stringify(seq.relations));
    expect(Object.values(bulk.relations).map((r) => r.id)).toEqual(Object.values(seq.relations).map((r) => r.id));
    // Previously existing relations keep their place when more are added on top.
    const more = addRelationsBulk(bulk, c2, [{ fromId: ids[4], toId: ids[0], label: "six", provenance: prov, id: "7", actor: USER }]);
    const again = addRelation(seq, c1, { fromId: ids[4], toId: ids[0], label: "six", provenance: prov, id: "7", actor: USER }).state;
    expect(Object.values(more.relations).map((r) => r.id)).toEqual(Object.values(again.relations).map((r) => r.id));
  });

  it("addRelationsBulk skips tolerated failures and leaves the table alone when nothing was added", () => {
    const { s, ids } = world();
    const ctx = createSequentialContext();
    const dup: AddRelationArgs = { fromId: ids[0], toId: ids[1], label: "x", provenance: prov, actor: USER };
    const once = addRelationsBulk(s, ctx, [dup]);
    expect(addRelationsBulk(once, ctx, [dup], new Set(["duplicate_relation"]))).toBe(once);
    expect(() => addRelationsBulk(once, ctx, [dup])).toThrow();
  });
});
