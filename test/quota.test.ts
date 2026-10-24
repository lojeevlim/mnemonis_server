import { afterEach, describe as baseDescribe, expect, it } from "vitest";
import { DEFAULT_QUOTAS } from "../src/store/quota.js";
import { StoreError } from "../src/store/types.js";
import { callTool, connectMcp, startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

const servers: TestServer[] = [];
const start = async (quotas: Parameters<typeof startTestServer>[0] = {}) => {
  const s = await startTestServer(quotas);
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const json = { "Content-Type": "application/json" };
type Err = { error: { code: string; message: string } };

describe("per-user quotas", () => {
  it("default to 5 MB of serialized workspace and 5000 memories", () => {
    expect(DEFAULT_QUOTAS).toEqual({ maxWorkspaceBytes: 5 * 1024 * 1024, maxMemories: 5000 });
  });

  it("REST ops: a write over the size cap is 422 too_large with a clear message, nothing is saved, the revision does not move", async () => {
    const s = await start({ quotas: { maxWorkspaceBytes: 8 * 1024 } });
    expect((await s.a.op("createMemory", { title: "small", content: "x".repeat(100) })).status).toBe(200);
    const before = (await s.service.getState()).rev;
    const r = await s.a.op("createMemory", { title: "big", content: "y".repeat(20_000) });
    expect(r.status).toBe(422);
    const b = (await r.json()) as Err;
    expect(b.error.code).toBe("too_large");
    expect(b.error.message).toBe("Your workspace has reached its size limit of 8 KB. Nothing was saved.");
    expect((await s.service.getState()).rev).toBe(before);
    expect(Object.keys((await s.service.getState()).state.memories)).toHaveLength(1);
    // the other user has their own quota usage
    expect((await s.b.op("createMemory", { title: "fine", content: "z".repeat(3000) })).status).toBe(200);
  });

  it("REST ops: the memory-count cap is enforced as 422 too_large", async () => {
    const s = await start({ quotas: { maxMemories: 3 } });
    for (let i = 0; i < 3; i++) expect((await s.a.op("createMemory", { title: `m${i}` })).status).toBe(200);
    const r = await s.a.op("createMemory", { title: "m3" });
    expect(r.status).toBe(422);
    const b = (await r.json()) as Err;
    expect(b.error.code).toBe("too_large");
    expect(b.error.message).toContain("3 memories");
    expect(Object.keys((await s.service.getState()).state.memories)).toHaveLength(3);
    expect((await s.b.op("createMemory", { title: "other user" })).status).toBe(200);
  });

  it("import PUT /api/state: over the size cap is 413 too_large; the same payload under the cap is accepted", async () => {
    const s = await start({ quotas: { maxWorkspaceBytes: 8 * 1024, maxMemories: 2 } });
    // build payloads through the service so they are valid domain states
    const donor = await start();
    for (let i = 0; i < 3; i++) await donor.a.op("createMemory", { title: `d${i}`, content: "c".repeat(50) });
    const three = JSON.stringify({ schemaVersion: 2, state: (await donor.service.getState()).state });
    const rev = (await s.service.getState()).rev;
    const over = await s.a.api("/api/state", { method: "PUT", headers: { ...json, "If-Match": `"${rev}"` }, body: three });
    expect(over.status).toBe(413);
    expect(((await over.json()) as Err).error.code).toBe("too_large");
    expect((await s.service.getState()).rev).toBe(rev);

    const one = await start();
    await one.a.op("createMemory", { title: "only", content: "c".repeat(50) });
    const small = JSON.stringify({ schemaVersion: 2, state: (await one.service.getState()).state });
    const ok = await s.a.api("/api/state", { method: "PUT", headers: { ...json, "If-Match": `"${rev}"` }, body: small });
    expect(ok.status).toBe(200);

    const bytes = await start({ quotas: { maxWorkspaceBytes: 1024 } });
    const big = await bytes.a.api("/api/state", { method: "PUT", headers: { ...json, "If-Match": '"0"' }, body: small.replace('"only"', `"${"t".repeat(2000)}"`) });
    expect(big.status).toBe(413);
  });

  it("Agent writes: a save over the cap is refused with code too_large and writes nothing", async () => {
    const s = await start({ quotas: { maxMemories: 2 } });
    const { token } = await s.a.mcpToken();
    const client = await connectMcp(s.url, s.a.mcpHeaders(token));
    expect((await callTool(client, "memory_save", { title: "one" })).isError).toBe(false);
    expect((await callTool(client, "memory_save", { title: "two" })).isError).toBe(false);
    const third = await callTool(client, "memory_save", { title: "three" });
    expect(third.isError).toBe(true);
    expect(third.data.error).toMatchObject({ code: "too_large" });
    expect(Object.keys((await s.service.getState()).state.memories)).toHaveLength(2);
  });

  it("PgStore.transact / replace / write all enforce it (StoreError too_large), and writes that do not grow a workspace already over its cap still work", async () => {
    const s = await start();
    const loose = s.services.forUser(s.a.id);
    for (let i = 0; i < 4; i++) await loose.createMemory({ title: `m${i}`, actor: { kind: "user", name: "t" } });
    const { PgStore } = await import("../src/store/pgStore.js");
    const strict = new PgStore(s.pool, { maxMemories: 3, maxWorkspaceBytes: 50 * 1024 * 1024 }).forUser(s.a.id); // 4 memories, cap 3: already over
    const state = (await s.service.getState()).state;
    await expect(strict.write({ ...state, memories: { ...state.memories, extra: Object.values(state.memories)[0]! } })).rejects.toMatchObject({ code: "too_large" });
    await expect(strict.replace(JSON.stringify({ ...state, memories: { ...state.memories, extra: Object.values(state.memories)[0]! } }))).rejects.toBeInstanceOf(StoreError);
    // not growing: re-writing the same set (e.g. an archive/approve) is allowed
    await expect(strict.transact((st) => ({ state: { ...st }, value: 1 }))).resolves.toMatchObject({ value: 1 });
    // shrinking is allowed
    const first = Object.keys(state.memories)[0]!;
    const { [first]: _drop, ...rest } = state.memories;
    void _drop;
    await expect(strict.write({ ...state, memories: rest, revisions: Object.fromEntries(Object.entries(state.revisions).filter(([, r]) => (r as { memoryId: string }).memoryId !== first)) })).resolves.toBeTruthy();
  });
});
