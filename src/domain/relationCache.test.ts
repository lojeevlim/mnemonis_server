import { describe, expect, it } from "vitest";
import { createSequentialContext, DomainError } from "./context.js";
import { archiveMemory, createMemory, updateMemory } from "./memoryOps.js";
import { addRelation, addRelationsBulk, approveRelation, deleteRelationsIn, rejectRelation, relationValues, removeRelation } from "./relations.js";
import { createEmptyWorkspace, validateWorkspaceState } from "./state.js";
import { AGENT, USER } from "./testUtils.js";
import type { WorkspaceState } from "./types.js";
import { approveAllDetailed, rejectAllDetailed } from "./versioning.js";

/**
 * Guard for the relationValues cache in relations.ts. Every state and relation object is deep-frozen (so any
 * in-place mutation of a table or relation throws), and after every step relationValues(table) must equal
 * Object.values(table) for ALL states retained so far (a stale or mis-ordered cached list would show up here).
 */

const PROV = { origin: "process" as const, createdBy: "x", process: "t" };

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const TOLERATED = new Set(["duplicate_relation", "endpoint_not_saved", "invalid_input", "duplicate_id"]);

describe("relationValues cache", () => {
  it("equals Object.values on every retained frozen state across randomized operation sequences", () => {
    let sawIntegerIds = false;
    let sawBulk = false;
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const ctx = createSequentialContext();
      let s: WorkspaceState = deepFreeze(createEmptyWorkspace());
      const history: WorkspaceState[] = [];
      const tags = ["t1", "t2", "t3"];
      const titles = ["A: x", "B: x", "C: x", "plain", "A: y"];
      const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
      const attempt = (f: () => WorkspaceState | undefined): WorkspaceState | undefined => {
        try {
          return f();
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          return undefined;
        }
      };
      const relArgs = (mems: string[], actor: typeof USER) => ({
        fromId: pick(mems),
        toId: pick(mems),
        label: pick(["l", "m"]),
        provenance: PROV,
        actor,
        id: r() < 0.4 ? String(Math.floor(r() * 20)) : undefined,
      });
      for (let step = 0; step < 40; step++) {
        const mems = Object.keys(s.memories);
        const rels = Object.keys(s.relations);
        const actor = r() < 0.5 ? USER : AGENT;
        const op = Math.floor(r() * 13);
        let n: WorkspaceState | undefined;
        if (op <= 1) n = attempt(() => createMemory(s, ctx, { title: pick(titles), tags: [pick(tags), pick(tags)], actor }).state);
        else if (op === 2 && mems.length) {
          n = attempt(() => updateMemory(s, ctx, { id: pick(mems), patch: { tags: [pick(tags)] }, actor }).state);
        } else if (op === 3 && mems.length > 1) n = attempt(() => addRelation(s, ctx, relArgs(mems, actor)).state);
        else if (op === 4 && mems.length > 1) {
          n = attempt(() => addRelationsBulk(s, ctx, [0, 1, 2].map(() => relArgs(mems, actor)), TOLERATED));
          sawBulk = true;
        } else if (op === 5 && rels.length) n = attempt(() => removeRelation(s, { id: pick(rels), actor: USER }, ctx).state);
        else if (op === 6 && rels.length) n = attempt(() => approveRelation(s, ctx, { relationId: pick(rels), actor: USER }).state);
        else if (op === 7 && rels.length) n = attempt(() => rejectRelation(s, ctx, { relationId: pick(rels), actor: USER }).state);
        else if (op === 8) n = attempt(() => approveAllDetailed(s, ctx, { actor: USER }).state);
        else if (op === 9) n = attempt(() => rejectAllDetailed(s, ctx, { actor: USER }).state);
        else if (op === 10 && rels.length) n = attempt(() => deleteRelationsIn(s, [pick(rels)]));
        else if (op === 11) {
          const v = validateWorkspaceState(JSON.parse(JSON.stringify(s)));
          expect(v.ok).toBe(true);
          n = v.ok ? v.state : undefined;
        } else if (op === 12 && mems.length) n = attempt(() => archiveMemory(s, ctx, { id: pick(mems), actor: USER }).state);
        if (!n) continue;
        // Sometimes populate the cache of the new table before freezing / before the next write builds on it.
        if (r() < 0.7) relationValues(n.relations);
        s = deepFreeze(n);
        history.push(s);
        if (Object.keys(s.relations).some((k) => /^\d+$/.test(k))) sawIntegerIds = true;
        for (const h of history) expect(relationValues(h.relations)).toEqual(Object.values(h.relations));
      }
    }
    expect(sawIntegerIds).toBe(true);
    expect(sawBulk).toBe(true);
  });
});
