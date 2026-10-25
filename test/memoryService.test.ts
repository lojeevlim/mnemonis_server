import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSequentialContext,
  DomainError,
  LIMITS,
  migrateWorkspaceState,
  SCHEMA_VERSION,
  type Actor,
} from "../src/domain/index.js";
import v1Seed from "../src/domain/__fixtures__/v1-seed.json";
import { toErrorInfo } from "../src/service/errors.js";
import { createMemoryService, type MemoryService } from "../src/service/memoryService.js";
import { agentActor, createAgentWriter, createRateLimiter, pendingAgentItems } from "../src/service/guards.js";
import { MemoryStore } from "./memoryStore.js";

const USER: Actor = { kind: "user", name: "me" };
let store: MemoryStore;
let service: MemoryService;

const fresh = () => {
  const s = new MemoryStore();
  return { store: s, service: createMemoryService({ store: s, ctx: createSequentialContext() }) };
};

beforeEach(() => {
  ({ store, service } = fresh());
});
afterEach(async () => {
  await store.close();
});

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => toErrorInfo(e).code);

describe("memoryService (user actor)", () => {
  it("user writes save at once and rev increases per mutation", async () => {
    const a = await service.createMemory({ title: "A", content: "hello", actor: USER });
    expect(a.rev).toBe(1);
    expect(a.value.status).toBe("saved");
    const b = await service.updateMemory({ id: a.value.id, patch: { content: "hi" }, actor: USER });
    expect(b.rev).toBe(2);
    expect((await service.getMemory(a.value.id)).content).toBe("hi");
    expect(await service.pendingCount()).toBe(0);
  });

  it("covers collections, relations, history, rollback, search, timeline", async () => {
    const col = await service.createCollection({ name: "Work" });
    const a = (await service.createMemory({ title: "Alpha", content: "one", collectionId: col.value.id, actor: USER })).value;
    const b = (await service.createMemory({ title: "Beta", actor: USER })).value;
    await service.updateMemory({ id: a.id, patch: { content: "two" }, actor: USER });
    const hist = await service.memoryHistory(a.id);
    expect(hist).toHaveLength(2);
    await service.rollbackMemory({ memoryId: a.id, toRevisionId: hist[1].id, actor: USER });
    expect((await service.getMemory(a.id)).content).toBe("one");
    const rel = await service.addRelation({ fromId: a.id, toId: b.id, label: "relates", actor: USER });
    expect(rel.value.status).toBe("saved");
    expect(await service.listRelations(a.id)).toHaveLength(1);
    await service.removeRelation({ id: rel.value.id, actor: USER });
    expect(await service.listRelations(a.id)).toHaveLength(0);
    expect((await service.searchWorkspace({ query: "alpha" })).total).toBe(1);
    expect((await service.timeline(2)).length).toBe(2);
    expect(await service.listCollections()).toHaveLength(1);
    await service.archiveMemory({ id: b.id, actor: USER });
    expect((await service.getMemory(b.id)).status).toBe("archived");
    await service.restoreMemory({ id: b.id, actor: USER });
    await service.updateCollection({ id: col.value.id, name: "Renamed" });
    expect(await code(service.deleteCollection({ id: col.value.id }))).toBe("collection_not_empty");
    await service.updateMemory({ id: a.id, patch: { collectionId: null }, actor: USER });
    await service.deleteCollection({ id: col.value.id });
    expect(await service.listCollections()).toHaveLength(0);
  });

  it("unknown ids give clean structured errors without stack traces", async () => {
    expect(await code(service.getMemory("nope"))).toBe("memory_not_found");
    expect(await code(service.memoryHistory("nope"))).toBe("memory_not_found");
    expect(await code(service.updateMemory({ id: "nope", patch: {}, actor: USER }))).toBe("memory_not_found");
    expect(await code(service.diffPending("nope"))).toBe("revision_not_found");
    expect(toErrorInfo(new Error("/secret/path boom"))).toEqual({ code: "internal", message: "Internal error" });
    expect((await service.getState()).rev).toBe(0);
  });

  it("the domain refuses review decisions from an agent actor", async () => {
    const w = createAgentWriter({ service });
    const m = (await w.save({ title: "x" })).value;
    const rev = (await service.pendingChanges())[0].revisionId;
    expect(m.status).toBe("pending");
    expect(await code(service.approveRevision({ revisionId: rev, actor: w.actor }))).toBe("forbidden");
  });
});

describe("agent writer (MCP path)", () => {
  it("save lands pending with agent origin/provenance; nothing visible as saved", async () => {
    const w = createAgentWriter({ service, clientName: "claude-code" });
    const r = await w.save({ title: "Idea", content: "body", tags: ["a"] });
    expect(r.value).toMatchObject({ status: "pending", provenance: { origin: "agent", createdBy: "claude-code" }, source: "mcp" });
    const [change] = await service.pendingChanges();
    expect(change).toMatchObject({ kind: "create", origin: "agent", author: "claude-code" });
    expect(await service.listMemories()).toHaveLength(0);
    expect((await service.diffPending(change.revisionId)).kind).toBe("added");
  });

  it("update and archive of a saved memory become pending; saved content is untouched until approval", async () => {
    const m = (await service.createMemory({ title: "T", content: "orig", actor: USER })).value;
    const w = createAgentWriter({ service, clientName: "bot" });
    await w.update({ id: m.id, patch: { content: "changed" } });
    expect(await service.getMemory(m.id)).toMatchObject({ content: "orig", hasPending: true });
    await w.archive({ id: m.id });
    const pend = await service.pendingChanges();
    expect(pend).toHaveLength(1); // same author continues/supersedes its own proposal
    expect(pend[0].kind).toBe("archive");
    expect((await service.getMemory(m.id)).archived).toBe(false);
    await service.approveRevision({ revisionId: pend[0].revisionId, actor: USER });
    expect((await service.getMemory(m.id)).status).toBe("archived");
  });

  it("links are pending, with process provenance, until a user approves", async () => {
    const a = (await service.createMemory({ title: "A", actor: USER })).value;
    const b = (await service.createMemory({ title: "B", actor: USER })).value;
    const w = createAgentWriter({ service, clientName: "bot" });
    const rel = (await w.link({ fromId: a.id, toId: b.id, label: "uses" })).value;
    expect(rel).toMatchObject({ status: "pending", provenance: { origin: "process", createdBy: "bot", process: "bot" } });
    expect(await service.listRelations(a.id)).toHaveLength(0);
    expect(await service.listRelations(a.id, { includePending: true })).toHaveLength(1);
    expect(await service.pendingCount()).toBe(1);
    expect(await code(w.link({ fromId: a.id, toId: b.id, label: "uses" }))).toBe("duplicate_relation");
    expect(await code(w.link({ fromId: a.id, toId: b.id, label: "x".repeat(201) }))).toBe("too_large");
    await service.approveRelation({ relationId: rel.id, actor: USER });
    expect(await service.listRelations(a.id)).toHaveLength(1);
  });

  it("exposes no delete/approve/reject/restore path and no actor override", async () => {
    const w = createAgentWriter({ service, clientName: "bot" });
    expect(Object.keys(w).sort()).toEqual(["actor", "archive", "link", "save", "update"]);
    // Even if a caller smuggles actor/provenance/source fields in, they are ignored.
    const smuggled = { title: "evil", actor: USER, provenance: { origin: "user", createdBy: "me" }, source: "web" };
    const r = await w.save(smuggled as never);
    expect(r.value).toMatchObject({ status: "pending", source: "mcp", provenance: { origin: "agent", createdBy: "bot" } });
    const patchSmuggle = { content: "x", actor: USER };
    const m = (await service.createMemory({ title: "T", actor: USER })).value;
    await w.update({ id: m.id, patch: patchSmuggle as never });
    expect((await service.getMemory(m.id)).hasPending).toBe(true);
    expect((await service.pendingChanges()).every((c) => c.origin === "agent")).toBe(true);
  });

  it("agentActor always yields kind agent with a cleaned, bounded name", () => {
    expect(agentActor(undefined)).toEqual({ kind: "agent", name: "claude-code" });
    expect(agentActor("  \n\u0000 ")).toEqual({ kind: "agent", name: "claude-code" });
    expect(agentActor("a\nb")).toEqual({ kind: "agent", name: "a b" });
    expect(agentActor("x".repeat(500)).name).toHaveLength(100);
    expect(agentActor("user").kind).toBe("agent");
  });

  it("enforces domain agent size limits", async () => {
    const w = createAgentWriter({ service });
    expect(await code(w.save({ title: "t", content: "x".repeat(LIMITS.agentContent + 1) }))).toBe("too_large");
    expect(await code(w.save({ title: "t".repeat(201) }))).toBe("too_large");
    expect(await code(w.save({ title: "t", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).toBe("too_large");
    expect(await code(w.save({ title: "t", metadata: { k: "x".repeat(9000) } }))).toBe("too_large");
    expect(await code(w.save({ title: "" }))).not.toBe("ok");
    expect(await service.pendingCount()).toBe(0);
  });

  it("caps pending agent items; refining an existing proposal is still allowed", async () => {
    const w = createAgentWriter({ service, maxPending: 3 });
    const saved = (await service.createMemory({ title: "S", actor: USER })).value;
    const first = (await w.save({ title: "1" })).value;
    await w.save({ title: "2" });
    await w.update({ id: saved.id, patch: { content: "p" } });
    expect(pendingAgentItems((await service.getState()).state)).toBe(3);
    const err = await w.save({ title: "4" }).catch((e: unknown) => toErrorInfo(e));
    expect(err).toMatchObject({ code: "inbox_full" });
    expect((err as { message: string }).message).toMatch(/review the Inbox/);
    expect(await code(w.link({ fromId: saved.id, toId: first.id, label: "l" }))).toBe("inbox_full");
    const other = (await service.createMemory({ title: "O", actor: USER })).value;
    expect(await code(w.update({ id: other.id, patch: { content: "q" } }))).toBe("inbox_full");
    expect(await code(w.update({ id: saved.id, patch: { content: "p2" } }))).toBe("ok"); // refines own proposal
    expect(await code(w.update({ id: first.id, patch: { content: "more" } }))).toBe("ok");
  });

  it("the default cap is 200", async () => {
    const w = createAgentWriter({ service });
    for (let i = 0; i < 200; i++) await w.save({ title: `m${i}` });
    expect(await code(w.save({ title: "one too many" }))).toBe("inbox_full");
    expect(await service.pendingCount()).toBe(200);
  }, 30_000);

  it("rate limiter blocks writes over the limit and recovers after the window", async () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    const w = createAgentWriter({ service, limiter });
    for (let i = 0; i < 3; i++) await w.save({ title: `m${i}` });
    expect(await code(w.save({ title: "no" }))).toBe("rate_limited");
    expect(await service.pendingCount()).toBe(3);
    t = 1001;
    expect(await code(w.save({ title: "yes" }))).toBe("ok");
    limiter.take("other-key"); // separate buckets
  });

  it("parallel agent saves are serialized with no loss", async () => {
    const w = createAgentWriter({ service });
    await Promise.all(Array.from({ length: 50 }, (_, i) => w.save({ title: `p${i}` })));
    expect(await service.pendingCount()).toBe(50);
    expect((await service.getState()).rev).toBe(50);
  });
});

describe("import / export round trip", () => {
  it("a v1 web export migrates through the service and persists", async () => {
    const snap = await service.importJson(JSON.stringify({ schemaVersion: 1, state: v1Seed }));
    const expected = migrateWorkspaceState(v1Seed);
    expect(expected.ok).toBe(true);
    if (expected.ok) expect(snap.state).toEqual(expected.state);
    expect(snap.rev).toBe(1);
    expect((await service.getState()).state).toEqual(snap.state); // durability across restarts is covered by pgStore.test.ts
  });

  it("a v2 export (user + agent + links + collection) re-imports identically into another store", async () => {
    const col = await service.createCollection({ name: "Col" });
    const a = (await service.createMemory({ title: "A", collectionId: col.value.id, actor: USER })).value;
    const b = (await service.createMemory({ title: "B", actor: USER })).value;
    await service.addRelation({ fromId: a.id, toId: b.id, label: "l", actor: USER });
    const w = createAgentWriter({ service, clientName: "bot" });
    await w.update({ id: a.id, patch: { content: "proposal" } });
    await w.save({ title: "new" });
    await w.link({ fromId: b.id, toId: a.id, label: "back" });
    const exported = await service.exportJson();
    expect(JSON.parse(exported)).toMatchObject({ schemaVersion: SCHEMA_VERSION });

    const other = fresh();
    try {
      const imported = await other.service.importJson(exported);
      expect(imported.state).toEqual((await service.getState()).state);
      expect(await other.service.pendingCount()).toBe(3);
      expect(await other.service.exportJson()).toBe(exported);
    } finally {
      await other.store.close();
    }
  });

  it("import honours If-Match and rejects garbage without changing state", async () => {
    const before = await service.getState();
    expect(await code(service.importJson("{}", { ifMatchRev: before.rev + 1 }))).toBe("conflict");
    expect(await code(service.importJson("{\"schemaVersion\":2}"))).toBe("invalid_input");
    expect((await service.getState()).rev).toBe(before.rev);
  });

  it("DomainError is the error type surfaced for domain failures", async () => {
    await expect(service.getMemory("x")).rejects.toBeInstanceOf(DomainError);
  });
});

describe("title-prefix auto-links (<project>: <data> -> <project>)", () => {
  const partOf = async (id: string, includePending = true) =>
    (await service.listRelations(id, { includePending })).filter((r) => r.label === "part of");

  it("an agent save of `VT: run build` proposes a pending link that is visible only after approval", async () => {
    const parent = (await service.createMemory({ title: "VT", actor: USER })).value;
    const w = createAgentWriter({ service, clientName: "bot" });
    const child = (await w.save({ title: "VT: run build" })).value;

    const [rel] = await partOf(child.id);
    expect(rel).toMatchObject({
      fromId: child.id,
      toId: parent.id,
      status: "pending",
      provenance: { origin: "process", createdBy: "bot", process: "title-prefix" },
    });
    expect(await partOf(child.id, false)).toHaveLength(0); // not in memory_related-style listing yet

    const pend = await service.pendingChanges();
    const revisionId = pend.find((p) => p.memoryId === child.id)!.revisionId;
    await service.approveRevision({ revisionId, actor: USER });
    expect(await partOf(child.id, false)).toHaveLength(0); // saving the memory does not approve the link
    expect((await partOf(child.id))).toHaveLength(1); // and no duplicate was created

    await service.approveRelation({ relationId: rel.id, actor: USER });
    expect(await partOf(child.id, false)).toMatchObject([{ id: rel.id, status: "saved", toId: parent.id }]);
    expect(await partOf(parent.id, false)).toHaveLength(1);
  });

  it("approveAll approves the memory and its auto-link together", async () => {
    await service.createMemory({ title: "VT", actor: USER });
    const w = createAgentWriter({ service, clientName: "bot" });
    const child = (await w.save({ title: "VT: deploy" })).value;
    const r = await service.approveAllDetailed({ actor: USER });
    expect(r.value.approvedRevisionIds).toHaveLength(1);
    expect(await partOf(child.id, false)).toHaveLength(1);
    expect(await service.pendingCount()).toBe(0);
  });

  it("a user rename drops the stale saved link", async () => {
    const parent = (await service.createMemory({ title: "VT", actor: USER })).value;
    const child = (await service.createMemory({ title: "VT: x", actor: USER })).value;
    expect(await partOf(child.id, false)).toMatchObject([{ toId: parent.id, status: "saved" }]);
    await service.updateMemory({ id: child.id, patch: { title: "Other: x" }, actor: USER });
    expect(await partOf(child.id)).toHaveLength(0);
    expect(await partOf(parent.id)).toHaveLength(0);
  });
});

describe("title-prefix marker cannot be forged by an agent", () => {
  it("an agent name equal to the reserved process is renamed (case-insensitive)", () => {
    expect(agentActor("title-prefix").name).toBe("title-prefix-client");
    expect(agentActor("  Title-Prefix ").name).toBe("Title-Prefix-client");
    expect(agentActor("title-prefix-x").name).toBe("title-prefix-x");
  });

  it("MCP memory_link from a client named `title-prefix` never yields process title-prefix", async () => {
    const a = (await service.createMemory({ title: "A", actor: USER })).value;
    const b = (await service.createMemory({ title: "B", actor: USER })).value;
    const w = createAgentWriter({ service, clientName: "title-prefix" });
    const rel = (await w.link({ fromId: a.id, toId: b.id, label: "part of" })).value;
    expect(rel.provenance).toMatchObject({ origin: "process", createdBy: "title-prefix-client", process: "title-prefix-client" });
  });

  it("topic-tag is reserved too: an agent name equal to it (any case/spacing) is renamed", () => {
    expect(agentActor("topic-tag").name).toBe("topic-tag-client");
    expect(agentActor(" Topic-Tag ").name).toBe("Topic-Tag-client");
    expect(agentActor("topic-tags").name).toBe("topic-tags");
  });

  it("MCP memory_link from a client named `topic-tag` gets process topic-tag-client", async () => {
    const a = (await service.createMemory({ title: "A", actor: USER })).value;
    const b = (await service.createMemory({ title: "B", actor: USER })).value;
    const w = createAgentWriter({ service, clientName: "topic-tag" });
    const rel = (await w.link({ fromId: a.id, toId: b.id, label: "shares topic: x" })).value;
    expect(rel.provenance).toMatchObject({ origin: "process", createdBy: "topic-tag-client", process: "topic-tag-client" });
  });

  it("the service default provenance is safe even for a directly constructed reserved agent actor", async () => {
    const a = (await service.createMemory({ title: "A", actor: USER })).value;
    const b = (await service.createMemory({ title: "B", actor: USER })).value;
    const rel = (await service.addRelation({ fromId: a.id, toId: b.id, label: "part of", actor: { kind: "agent", name: "title-prefix" } })).value;
    expect(rel.provenance.process).toBe("title-prefix-client");
  });
});

describe("topic auto-links (shared tag across projects)", () => {
  const topicLinks = async (id: string, includePending = true) =>
    (await service.listRelations(id, { includePending })).filter((r) => r.label.startsWith("shares topic: "));

  it("an agent save sharing a tag with another project proposes one pending link, visible only after approval", async () => {
    const a = (await service.createMemory({ title: "A: stripe notes", tags: ["stripe"], actor: USER })).value;
    const w = createAgentWriter({ service, clientName: "bot" });
    const b = (await w.save({ title: "B: payments", tags: ["stripe"] })).value;

    const links = await topicLinks(b.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      label: "shares topic: stripe",
      status: "pending",
      provenance: { origin: "process", createdBy: "bot", process: "topic-tag" },
    });
    expect([links[0].fromId, links[0].toId].sort()).toEqual([a.id, b.id].sort());
    expect(await topicLinks(b.id, false)).toHaveLength(0);
    expect(await topicLinks(a.id, false)).toHaveLength(0);

    const pend = await service.pendingChanges();
    await service.approveRevision({ revisionId: pend.find((p) => p.memoryId === b.id)!.revisionId, actor: USER });
    expect(await topicLinks(b.id, false)).toHaveLength(0); // approving the memory does not approve the link
    await service.approveRelation({ relationId: links[0].id, actor: USER });
    expect(await topicLinks(b.id, false)).toHaveLength(1);
    expect(await topicLinks(a.id, false)).toHaveLength(1);
  });

  it("approveAll approves the memory and its topic link; a user removing the tag drops the saved link", async () => {
    const a = (await service.createMemory({ title: "A: stripe notes", tags: ["stripe"], actor: USER })).value;
    const w = createAgentWriter({ service, clientName: "bot" });
    const b = (await w.save({ title: "B: payments", tags: ["stripe"] })).value;
    const r = await service.approveAllDetailed({ actor: USER });
    expect(r.value.approvedRevisionIds).toHaveLength(1);
    expect(await topicLinks(b.id, false)).toHaveLength(1);
    expect(await service.pendingCount()).toBe(0);

    await service.updateMemory({ id: b.id, patch: { tags: [] }, actor: USER });
    expect(await topicLinks(b.id)).toHaveLength(0);
    expect(await topicLinks(a.id)).toHaveLength(0);
  });

  it("memories of the same project are not linked", async () => {
    await service.createMemory({ title: "A: stripe notes", tags: ["stripe"], actor: USER });
    const w = createAgentWriter({ service, clientName: "bot" });
    const b = (await w.save({ title: "A: webhooks", tags: ["stripe"] })).value;
    expect(await topicLinks(b.id)).toHaveLength(0);
  });

  it("a burst is bounded (3 per project, 12 per call) and the inbox cap check is unchanged", async () => {
    for (let p = 1; p <= 5; p++) {
      for (let i = 1; i <= 5; i++) await service.createMemory({ title: `P${p}: note ${i}`, tags: ["stripe"], actor: USER });
    }
    const w = createAgentWriter({ service, clientName: "bot", maxPending: 14 });
    const m = (await w.save({ title: "Z: payments", tags: ["stripe"] })).value;
    const links = await topicLinks(m.id);
    expect(links).toHaveLength(12);
    const perProject = new Map<string, number>();
    for (const l of links) {
      const other = await service.getMemory(l.fromId === m.id ? l.toId : l.fromId);
      const proj = other.title.split(":")[0];
      perProject.set(proj, (perProject.get(proj) ?? 0) + 1);
    }
    expect(perProject.size).toBe(4);
    for (const n of perProject.values()) expect(n).toBeLessThanOrEqual(3);

    // 1 proposal + 12 links = 13 pending < cap 14: one more save is still allowed; the next is refused.
    expect(pendingAgentItems((await service.getState()).state)).toBe(13);
    await w.save({ title: "Y: other" }); // 13 < 14 still allowed (14 pending afterwards)
    expect(await code(w.save({ title: "X: other" }))).toBe("inbox_full");
  });
});
