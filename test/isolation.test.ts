import { afterEach, beforeEach, describe as baseDescribe, expect, it } from "vitest";
import { createRateLimiter } from "../src/service/guards.js";
import { agentHeaders, callTool, connectMcp, startTestServer, TEST_DB_URL, type AgentClient, type TestServer, type TestUser } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

let t: TestServer;
const servers: TestServer[] = [];
const clients: AgentClient[] = [];
const start = async (o: Parameters<typeof startTestServer>[0] = {}) => {
  const s = await startTestServer(o);
  servers.push(s);
  return s;
};
const connect = async (s: TestServer, u: TestUser, name = "agent") => {
  const c = await connectMcp(s.url, u.mcpHeaders((await u.mcpToken()).token), name);
  clients.push(c);
  return c;
};
beforeEach(async () => {
  t = await start();
});
afterEach(async () => {
  clients.splice(0);
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

type St = { rev: number; state: { memories: Record<string, unknown>; revisions: Record<string, { status: string; author: string; id: string }> } };
const state = async (u: TestUser) => (await (await u.api("/api/state")).json()) as St;
const created = async (u: TestUser, title: string) =>
  (await (await u.op("createMemory", { title, content: `${title}-body` })).json()) as { rev: number; value: { id: string } };

describe("cross-account isolation over REST", () => {
  it("A never sees B's state, export, rev or ids; same rev numbers are independent", async () => {
    const a1 = await created(t.a, "A-ONLY-TITLE");
    expect(a1.rev).toBe(1);
    const b1 = await created(t.b, "B-ONLY-TITLE");
    expect(b1.rev).toBe(1); // independent counters
    await created(t.b, "B2");
    expect((await state(t.a)).rev).toBe(1);
    expect((await state(t.b)).rev).toBe(2);
    expect((await t.a.api("/api/state")).headers.get("etag")).toBe('"1"');
    expect(JSON.stringify(await state(t.a))).not.toContain("B-ONLY-TITLE");
    expect(await (await t.a.api("/api/export")).text()).not.toContain("B-ONLY-TITLE");
    expect(await (await t.b.api("/api/export")).text()).not.toContain("A-ONLY-TITLE");
  });

  it("using the other user's ids is plain not-found, and changes nothing", async () => {
    const a = await created(t.a, "Mine");
    const b = await created(t.b, "Theirs");
    for (const [name, body] of [
      ["archiveMemory", { id: a.value.id }],
      ["updateMemory", { id: a.value.id, patch: { title: "hijack" } }],
      ["addRelation", { fromId: a.value.id, toId: b.value.id, label: "x" }],
      ["approve", { revisionId: Object.keys((await state(t.a)).state.revisions)[0] }],
    ] as const) {
      const r = await t.b.op(name, body);
      expect(r.status, name).toBe(404);
    }
    const after = await state(t.a);
    expect(after.rev).toBe(1);
    expect(Object.values(after.state.revisions).every((r) => r.status === "saved")).toBe(true);
    expect((await state(t.b)).rev).toBe(1); // only B's own create
  });

  it("PUT /api/state on one account (with its own If-Match) leaves the other untouched", async () => {
    await created(t.b, "B-KEEP");
    const exported = await (await t.a.api("/api/export")).text();
    await created(t.a, "A1");
    const stale = await t.a.api("/api/state", { method: "PUT", headers: { "If-Match": '"0"' }, body: exported });
    expect(stale.status).toBe(409);
    const ok = await t.a.api("/api/state", { method: "PUT", headers: { "If-Match": '"1"' }, body: exported });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await state(t.b))).toContain("B-KEEP");
    expect((await state(t.b)).rev).toBe(1);
  });

  it("a userId in the path, query or body is never honoured", async () => {
    await created(t.b, "B-SECRET");
    const q = await t.a.api(`/api/state?userId=${t.b.id}&user_id=${t.b.id}`);
    expect(JSON.stringify(await q.json())).not.toContain("B-SECRET");
    const r = await t.a.op("createMemory", { title: "x", userId: t.b.id });
    expect(r.status).toBe(400); // strict schema refuses the unknown key
    const me = (await (await t.a.api(`/api/me?id=${t.b.id}`)).json()) as { id: string };
    expect(me.id).toBe(t.a.id);
  });
});

describe("cross-account isolation over MCP", () => {
  it("each token only reaches its own user's workspace", async () => {
    const ca = await connect(t, t.a, "agent-a");
    const cb = await connect(t, t.b, "agent-b");
    const saved = await callTool(ca, "memory_save", { title: "A-AGENT-NOTE" });
    expect(saved.data.status).toBe("pending");
    expect((await state(t.b)).rev).toBe(0);
    expect(JSON.stringify(await state(t.b))).not.toContain("A-AGENT-NOTE");
    expect((await callTool(cb, "memory_status")).data.pending.total).toBe(0);
    const read = await callTool(cb, "memory_read", { id: saved.data.memoryId });
    expect(read.isError).toBe(true);
    expect(read.data.error.code).toMatch(/not_found/);
    expect((await callTool(cb, "memory_diff", { revisionId: saved.data.revisionId })).isError).toBe(true);
    expect((await callTool(ca, "memory_status")).data.pending.total).toBe(1);
  });

  it("A hitting the inbox cap does not affect B (cap is per workspace)", async () => {
    const s = await start({ maxPending: 2 });
    const ca = await connect(s, s.a);
    const cb = await connect(s, s.b);
    await callTool(ca, "memory_save", { title: "1" });
    await callTool(ca, "memory_save", { title: "2" });
    expect((await callTool(ca, "memory_save", { title: "3" })).data.error.code).toBe("inbox_full");
    expect((await callTool(cb, "memory_save", { title: "b1" })).isError).toBe(false);
  });

  it("the rate limit is per user: A's limit spares B, and A's two tokens share one bucket", async () => {
    const s = await start({ limiter: createRateLimiter({ max: 3 }) });
    const a1 = await connect(s, s.a);
    const a2 = await connect(s, s.a);
    const cb = await connect(s, s.b);
    expect((await callTool(a1, "memory_save", { title: "1" })).isError).toBe(false);
    expect((await callTool(a2, "memory_save", { title: "2" })).isError).toBe(false);
    expect((await callTool(a1, "memory_save", { title: "3" })).isError).toBe(false);
    expect((await callTool(a2, "memory_save", { title: "4" })).data.error.code).toBe("rate_limited");
    expect((await callTool(a1, "memory_save", { title: "5" })).data.error.code).toBe("rate_limited");
    expect((await callTool(cb, "memory_save", { title: "b" })).isError).toBe(false);
  });

  it("client names are kept per token: no bleed between two tokens of one user or between users", async () => {
    const one = await connect(t, t.a, "agent-one");
    const two = await connect(t, t.a, "agent-two");
    const bee = await connect(t, t.b, "agent-bee");
    const r1 = await callTool(one, "memory_save", { title: "1" });
    const r2 = await callTool(two, "memory_save", { title: "2" });
    const rb = await callTool(bee, "memory_save", { title: "b" });
    const sa = await state(t.a);
    expect(sa.state.revisions[r1.data.revisionId].author).toBe("agent-one");
    expect(sa.state.revisions[r2.data.revisionId].author).toBe("agent-two");
    expect((await state(t.b)).state.revisions[rb.data.revisionId].author).toBe("agent-bee");
  });
});

describe("actor and approval", () => {
  it("an mcp write is pending as an agent, and only the user's session can approve it", async () => {
    const c = await connect(t, t.a, "claude-code");
    const saved = await callTool(c, "memory_save", { title: "Needs approval" });
    const rev = (await state(t.a)).state.revisions[saved.data.revisionId];
    expect(rev).toMatchObject({ status: "pending", author: "claude-code" });
    const { token } = await t.a.mcpToken();
    const viaMcp = await fetch(`${t.url}/api/ops/approve`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ revisionId: saved.data.revisionId }) });
    expect(viaMcp.status).toBe(401);
    expect((await state(t.a)).state.revisions[saved.data.revisionId].status).toBe("pending");
    expect((await t.b.op("approve", { revisionId: saved.data.revisionId })).status).toBe(404);
    const ok = await t.a.op("approve", { revisionId: saved.data.revisionId });
    expect(ok.status).toBe(200);
    expect((await state(t.a)).state.revisions[saved.data.revisionId].status).toBe("saved");
  });

  it("a body actor of kind user is ignored; the actor name is the user's display name", async () => {
    const r = (await (await t.a.op("createMemory", { title: "x", actor: { kind: "user", name: "Mallory" } })).json()) as St & { value: { id: string } };
    const rev = Object.values(r.state.revisions)[0];
    expect(rev.author).toBe("User A");
  });
});

describe("revoked, expired, disabled and deleted credentials are refused per user", () => {
  it("one user's session or token problems never affect the other", async () => {
    const tokA = await t.a.mcpToken();
    const tokB = await t.b.mcpToken();
    const mcpStatus = async (token: string) => (await fetch(`${t.url}/api/agent/ping`, { headers: agentHeaders(token) })).status;

    // revoked session
    await t.pool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [t.a.id]);
    expect((await t.a.api("/api/state")).status).toBe(401);
    expect((await t.b.api("/api/state")).status).toBe(200);
    // expired session
    await t.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [t.b.id]);
    expect((await t.b.api("/api/state")).status).toBe(401);

    // revoked mcp token: only that one
    const second = await t.a.mcpToken();
    await t.pool.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1", [tokA.id]);
    expect(await mcpStatus(tokA.token)).toBe(401);
    expect(await mcpStatus(second.token)).toBe(200);
    expect(await mcpStatus(tokB.token)).toBe(200);
    // disabled user: both doors for that user only
    await t.pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [t.a.id]);
    expect(await mcpStatus(second.token)).toBe(401);
    expect(await mcpStatus(tokB.token)).toBe(200);
    // deleted user: data and credentials gone, the other user's data intact
    await created(t.b, "B-SURVIVES");
    await t.pool.query("DELETE FROM users WHERE id = $1", [t.a.id]);
    expect(await mcpStatus(second.token)).toBe(401);
    expect((await t.pool.query("SELECT 1 FROM workspaces WHERE user_id = $1", [t.a.id])).rowCount).toBe(0);
    const fresh = (await t.pool.query("SELECT 1 FROM workspaces WHERE user_id = $1", [t.b.id])).rowCount;
    expect(fresh).toBe(1);
  });

  it("a user's session cannot list, create or revoke another user's tokens, or read their profile", async () => {
    const bTok = await t.b.mcpToken("b-secret-label");
    const list = JSON.stringify(await (await t.a.api("/api/tokens")).json());
    expect(list).not.toContain(bTok.id);
    expect(list).not.toContain("b-secret-label");
    expect((await t.a.api(`/api/tokens/${bTok.id}`, { method: "DELETE" })).status).toBe(404);
    const stillWorks = await fetch(`${t.url}/api/agent/ping`, { headers: agentHeaders(bTok.token) });
    expect(stillWorks.status).toBe(200);
    const me = (await (await t.a.api("/api/auth/me")).json()) as { id: string; email: string };
    expect(me).toMatchObject({ id: t.a.id, email: t.a.email });
  });

  it("deleting account A leaves B's workspace revision counter and data untouched", async () => {
    await created(t.b, "B-KEEP-1");
    const del = await fetch(`${t.url}/api/auth/me`, { method: "DELETE", headers: t.a.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ password: t.a.password }) });
    expect(del.status).toBe(204);
    const st = await state(t.b);
    expect(st.rev).toBe(1);
    expect(JSON.stringify(st)).toContain("B-KEEP-1");
  });
});
