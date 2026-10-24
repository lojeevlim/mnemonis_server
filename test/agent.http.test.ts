import { afterEach, beforeEach, describe as baseDescribe, expect, it } from "vitest";
import { createFailureLimiter } from "../src/http/auth.js";
import { validMcpUrl, parseConfig } from "../src/config.js";
import { createRateLimiter } from "../src/service/guards.js";
import { agentHeaders, agentPost, startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

let t: TestServer;
beforeEach(async () => {
  t = await startTestServer();
});
afterEach(async () => {
  await t.close();
});

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (r: Response) => (await r.json()) as J;
const stateOf = async (s: TestServer = t) => (await (await s.api("/api/state")).json()) as { state: { revisions: Record<string, J>; memories: Record<string, J>; relations: Record<string, J> } };

async function savedMemory(title = "Saved note", content = "Saved content", s: TestServer = t) {
  const r = (await (await s.op("createMemory", { title, content })).json()) as { value: { id: string } };
  return r.value.id;
}

describe("auxiliary endpoints", () => {
  it("GET /api/agent/ping needs an mn_ token and the contract header, answers {ok:true,contract:1}", async () => {
    const { token } = await t.a.mcpToken();
    const r = await fetch(`${t.url}/api/agent/ping`, { headers: agentHeaders(token) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, contract: 1 });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-mnemonis-contract")).toBe("1");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET /api/agent/contract is public and lists exactly the 11 tools", async () => {
    const r = await fetch(`${t.url}/api/agent/contract`);
    expect(r.status).toBe(200);
    const b = await body(r);
    expect(b).toMatchObject({ contract: "mnemonis-agent", version: 1, minSupported: 1 });
    expect(b.tools).toHaveLength(11);
    expect(b.tools).not.toContain("memory_delete");
  });

  it("the public contract endpoint is rate limited per client", async () => {
    const s = await startTestServer({ contractLimiter: createFailureLimiter({ max: 2, windowMs: 60_000 }) });
    try {
      expect((await fetch(`${s.url}/api/agent/contract`)).status).toBe(200);
      expect((await fetch(`${s.url}/api/agent/contract`)).status).toBe(200);
      const r = await fetch(`${s.url}/api/agent/contract`);
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("60");
    } finally {
      await s.close();
    }
  });

  it("GET /api/auth/config returns {registrationOpen, mcpUrl}", async () => {
    const s = await startTestServer({ mcpUrl: "http://localhost:8788/mcp" });
    try {
      expect(await (await fetch(`${s.url}/api/auth/config`)).json()).toEqual({ registrationOpen: true, mcpUrl: "http://localhost:8788/mcp" });
    } finally {
      await s.close();
    }
  });

  it("mcpUrl validation: https or loopback http, path /mcp, no credentials/query/fragment", () => {
    for (const ok of ["http://localhost:8788/mcp", "http://127.0.0.1:8788/mcp", "https://mcp.example.com/mcp", "http://[::1]:8788/mcp"]) expect(validMcpUrl(ok), ok).toBe(true);
    for (const bad of ["http://example.com/mcp", "https://u:p@example.com/mcp", "https://example.com/mcp?x=1", "https://example.com/mcp#f", "https://example.com/other", "ftp://localhost/mcp", "nope", "https://example.com/mcp/"]) {
      expect(validMcpUrl(bad), bad).toBe(false);
    }
    const base = { DATABASE_URL: "postgres://u:p@localhost/x" };
    expect(parseConfig(base).mcpUrl).toBe("http://localhost:8788/mcp");
    expect(parseConfig({ ...base, MNEMONIS_MCP_URL: "https://mcp.example.com/mcp" }).mcpUrl).toBe("https://mcp.example.com/mcp");
    expect(() => parseConfig({ ...base, MNEMONIS_MCP_URL: "http://example.com/mcp" })).toThrow(/MNEMONIS_MCP_URL/);
    expect(parseConfig(base)).toMatchObject({ maxPending: 200, agentWritesPerMinute: 60, agentReadsPerMinute: 300 });
  });
});

describe("tool endpoints", () => {
  it("save is a pending agent proposal; the client header names the author; nothing else is chosen by the caller", async () => {
    const { token } = await t.a.mcpToken();
    const r = await agentPost(t.url, token, "memory_save", { title: "Prefers tabs", content: "Use tabs", type: "preference", tags: ["s"] }, { "X-Mnemonis-Client": "claude-code-test" });
    expect(r.status).toBe(200);
    const b = await body(r);
    expect(b).toMatchObject({ status: "pending", memoryId: expect.any(String), revisionId: expect.any(String) });
    expect(Object.keys(b)).not.toContain("notice");
    const rev = (await stateOf()).state.revisions[b.revisionId];
    expect(rev).toMatchObject({ status: "pending", origin: "agent", author: "claude-code-test" });
    expect((await stateOf()).state.memories[b.memoryId]).toMatchObject({ source: "mcp" });
    // reads see only saved content
    expect((await body(await agentPost(t.url, token, "memory_list", {}))).memories).toEqual([]);
    expect(await t.op("approve", { revisionId: b.revisionId })).toHaveProperty("status", 200);
    const list = await body(await agentPost(t.url, token, "memory_list", {}));
    expect(list).toMatchObject({ total: 1, limit: 20, offset: 0 });
    expect(list.memories[0]).toMatchObject({ title: "Prefers tabs", source: "mcp" });
  });

  it("defaults the author to claude-code and sanitises the client header", async () => {
    const { token } = await t.a.mcpToken();
    const none = await body(await agentPost(t.url, token, "memory_save", { title: "a" }));
    expect((await stateOf()).state.revisions[none.revisionId]!.author).toBe("claude-code");
    // non printable ASCII or too long: ignored (never trusted, never an error)
    const weird = await body(await agentPost(t.url, token, "memory_save", { title: "b" }, { "X-Mnemonis-Client": "x".repeat(101) }));
    expect((await stateOf()).state.revisions[weird.revisionId]!.author).toBe("claude-code");
  });

  it("update / archive / link are pending and report no_change", async () => {
    const id = await savedMemory("Original", "Body");
    const other = await savedMemory("Other");
    const { token } = await t.a.mcpToken();
    const u = await body(await agentPost(t.url, token, "memory_update", { id, content: "New" }));
    expect(u.status).toBe("pending");
    expect((await body(await agentPost(t.url, token, "memory_update", { id: other, title: "Other" }))).status).toBe("no_change");
    expect((await body(await agentPost(t.url, token, "memory_update", { id }))).error.code).toBe("invalid_input");
    const a = await body(await agentPost(t.url, token, "memory_archive", { id: other }));
    expect(a.status).toBe("pending");
    const l = await body(await agentPost(t.url, token, "memory_link", { fromId: id, toId: other, label: "relates" }));
    expect(l).toMatchObject({ status: "pending", relationId: expect.any(String) });
    expect((await stateOf()).state.relations[l.relationId]!.status).toBe("pending");
    const read = await body(await agentPost(t.url, token, "memory_read", { id }));
    expect(read.memory.content).toBe("Body");
    expect(read.pendingProposal).toMatchObject({ revisionId: u.revisionId });
    const st = await body(await agentPost(t.url, token, "memory_status", {}));
    expect(st.pending).toMatchObject({ total: 3, proposals: 2, links: 1, inboxCap: 200 });
    const hist = await body(await agentPost(t.url, token, "memory_history", { id }));
    expect(hist.revisions).toHaveLength(1);
    const diff = await body(await agentPost(t.url, token, "memory_diff", { revisionId: u.revisionId }));
    expect(diff).toMatchObject({ kind: "modified", memoryId: id });
    expect((await body(await agentPost(t.url, token, "memory_related", { id }))).related).toEqual([]);
    expect((await body(await agentPost(t.url, token, "memory_search", { query: "Original" }))).results).toHaveLength(1);
  });

  it("error mapping: 404, 409, 400 with {error:{code,message}}", async () => {
    const { token } = await t.a.mcpToken();
    const nf = await agentPost(t.url, token, "memory_read", { id: "mem_nope" });
    expect(nf.status).toBe(404);
    expect((await body(nf)).error).toMatchObject({ code: "memory_not_found" });
    const id = await savedMemory();
    const rev = Object.values((await stateOf()).state.revisions).find((r) => r.memoryId === id)!;
    const np = await agentPost(t.url, token, "memory_diff", { revisionId: rev.id });
    expect(np.status).toBe(409);
    expect((await body(np)).error.code).toBe("not_pending");
    const bad = await agentPost(t.url, token, "memory_diff", {});
    expect(bad.status).toBe(400);
    expect((await body(bad)).error.code).toBe("invalid_input");
    expect((await agentPost(t.url, token, "memory_link", { fromId: "a", toId: "b", label: "x" })).status).toBe(404);
  });

  it("caps from the domain are 422 too_large", async () => {
    const { token } = await t.a.mcpToken();
    const r = await agentPost(t.url, token, "memory_save", { title: "ok", metadata: { big: "x".repeat(9000) } });
    expect(r.status).toBe(422);
    expect((await body(r)).error.code).toBe("too_large");
  });
});

describe("strict bodies and transport rules", () => {
  const forbidden: Record<string, unknown>[] = [
    { title: "x", actor: { kind: "user", name: "me" } },
    { title: "x", origin: "user" },
    { title: "x", source: "web" },
    { title: "x", provenance: { origin: "user", createdBy: "me" } },
    { title: "x", author: "me" },
    { title: "x", createdBy: "me" },
    { title: "x", id: "mem_forced" },
  ];
  it.each(forbidden)("memory_save rejects %j with 400 invalid_input", async (payload) => {
    const { token } = await t.a.mcpToken();
    const r = await agentPost(t.url, token, "memory_save", payload);
    expect(r.status).toBe(400);
    expect((await body(r)).error.code).toBe("invalid_input");
    expect(Object.keys((await stateOf()).state.memories)).toEqual([]);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ["memory_search", {}],
    ["memory_search", { query: "x".repeat(501) }],
    ["memory_search", { query: "ok", limit: 101 }],
    ["memory_search", { query: "ok", offset: -1 }],
    ["memory_read", {}],
    ["memory_read", { id: "x".repeat(201) }],
    ["memory_list", { limit: 0 }],
    ["memory_list", { status: "deleted" }],
    ["memory_related", { id: 5 }],
    ["memory_history", { id: "m", limit: 101 }],
    ["memory_status", { recent: 51 }],
    ["memory_diff", { bogus: 1 }],
    ["memory_save", {}],
    ["memory_save", { title: "x".repeat(201) }],
    ["memory_save", { title: "x", tags: Array(21).fill("t") }],
    ["memory_save", { title: "x", tags: ["x".repeat(51)] }],
    ["memory_save", { title: "x", content: "x".repeat(50_001) }],
    ["memory_save", { title: "x", type: "" }],
    ["memory_update", { title: "no id" }],
    ["memory_link", { fromId: "a", toId: "b" }],
    ["memory_link", { fromId: "a", toId: "b", label: "x".repeat(201) }],
    ["memory_archive", { id: "" }],
  ];
  it.each(invalid)("%s rejects %j", async (tool, payload) => {
    const { token } = await t.a.mcpToken();
    const r = await agentPost(t.url, token, tool, payload);
    expect(r.status).toBe(400);
    expect((await body(r)).error.code).toBe("invalid_input");
  });

  it("non-JSON, non-object and wrong content type", async () => {
    const { token } = await t.a.mcpToken();
    expect((await agentPost(t.url, token, "memory_save", "{not json")).status).toBe(400);
    expect((await agentPost(t.url, token, "memory_save", "[1]")).status).toBe(400);
    expect((await agentPost(t.url, token, "memory_save", "null")).status).toBe(400);
    const r = await agentPost(t.url, token, "memory_save", { title: "x" }, { "Content-Type": "text/plain" });
    expect(r.status).toBe(415);
    expect((await body(r)).error.code).toBe("unsupported_media_type");
    expect((await agentPost(t.url, token, "memory_save", { title: "x" }, { "Content-Type": "application/json; charset=utf-8" })).status).toBe(200);
  });

  it("contract header: missing or unsupported is 426 contract_unsupported (after auth)", async () => {
    const { token } = await t.a.mcpToken();
    for (const h of [undefined, "2", "0", "abc"]) {
      const headers = agentHeaders(token);
      if (h === undefined) delete headers["X-Mnemonis-Contract"];
      else headers["X-Mnemonis-Contract"] = h;
      const r = await fetch(`${t.url}/api/agent/memory/status`, { method: "POST", headers, body: "{}" });
      expect(r.status, String(h)).toBe(426);
      expect((await body(r)).error.code).toBe("contract_unsupported");
    }
    const noAuth = await fetch(`${t.url}/api/agent/memory/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(noAuth.status).toBe(401); // the contract is not disclosed to an unauthenticated caller
  });

  it("body over 512 KiB is 413 too_large", async () => {
    const { token } = await t.a.mcpToken();
    const r = await agentPost(t.url, token, "memory_save", JSON.stringify({ title: "x", content: "y".repeat(600 * 1024) }));
    expect(r.status).toBe(413);
    expect((await body(r)).error.code).toBe("too_large");
  });

  it("X-Request-Id is echoed when valid and replaced when not", async () => {
    const { token } = await t.a.mcpToken();
    const ok = await agentPost(t.url, token, "memory_status", {}, { "X-Request-Id": "req-1234.abcd_EF" });
    expect(ok.headers.get("x-request-id")).toBe("req-1234.abcd_EF");
    for (const bad of ["short", "has space here!", "x".repeat(65)]) {
      const r = await agentPost(t.url, token, "memory_status", {}, { "X-Request-Id": bad });
      expect(r.headers.get("x-request-id")).not.toBe(bad);
      expect(r.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    }
    expect((await fetch(`${t.url}/api/agent/memory/status`, { method: "POST", headers: agentHeaders("mn_bad") })).headers.get("x-request-id")).toBeTruthy();
  });

  it("unknown paths and methods below /api/agent are 404 (never the session middleware)", async () => {
    const { token } = await t.a.mcpToken();
    expect((await fetch(`${t.url}/api/agent/memory/delete`, { method: "POST", headers: agentHeaders(token), body: "{}" })).status).toBe(404);
    expect((await fetch(`${t.url}/api/agent/memory/approve`, { method: "POST", headers: agentHeaders(token), body: "{}" })).status).toBe(404);
    expect((await fetch(`${t.url}/api/agent/memory/save`, { headers: agentHeaders(token) })).status).toBe(404);
    expect((await fetch(`${t.url}/api/agent/nope`, { headers: agentHeaders(token) })).status).toBe(404);
  });
});

describe("surface separation", () => {
  const json = { "Content-Type": "application/json", "X-Mnemonis-Contract": "1" };
  const shape = async (r: Response) => ({ status: r.status, body: await r.text(), www: r.headers.get("www-authenticate") });

  it("an ms_ session is a 401 on /api/agent/*, identical to no credentials", async () => {
    const none = await shape(await fetch(`${t.url}/api/agent/ping`, { headers: json }));
    expect(none.status).toBe(401);
    expect(none.www).toBe('Bearer realm="mnemonis"');
    for (const [method, path, b] of [
      ["GET", "/api/agent/ping", undefined],
      ["POST", "/api/agent/memory/save", { title: "x" }],
      ["POST", "/api/agent/memory/status", {}],
    ] as const) {
      const r = await fetch(`${t.url}${path}`, { method, headers: { ...json, Authorization: `Bearer ${t.a.session}` }, body: b ? JSON.stringify(b) : undefined });
      expect(await shape(r), path).toEqual(none);
    }
    expect(Object.keys((await stateOf()).state.memories)).toEqual([]);
  });

  it("an mn_ token is a 401 on the rest of /api/*", async () => {
    const { token } = await t.a.mcpToken();
    const baseline = await shape(await fetch(`${t.url}/api/state`));
    expect(baseline.status).toBe(401);
    for (const [method, path] of [["GET", "/api/state"], ["GET", "/api/tokens"], ["POST", "/api/tokens"], ["POST", "/api/ops/approve"], ["GET", "/api/export"], ["GET", "/api/auth/me"]] as const) {
      const r = await fetch(`${t.url}${path}`, { method, headers: { ...json, Authorization: `Bearer ${token}` }, body: method === "POST" ? "{}" : undefined });
      expect(await shape(r), `${method} ${path}`).toEqual(baseline);
    }
  });

  it("any Origin header is refused on /api/agent/*, even an allowed browser origin, without CORS headers", async () => {
    const { token } = await t.a.mcpToken();
    for (const origin of ["http://localhost:5173", "http://evil.test"]) {
      const r = await fetch(`${t.url}/api/agent/ping`, { headers: agentHeaders(token, { Origin: origin }) });
      expect(r.status, origin).toBe(403);
      expect((await body(r)).error.code).toBe("forbidden_origin");
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      const pre = await fetch(`${t.url}/api/agent/memory/save`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
      expect(pre.status).toBe(403);
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("revoked, expired and disabled-user tokens are the same 401", async () => {
    const live = await t.a.mcpToken();
    const revoked = await t.a.mcpToken("revoked");
    expect((await t.a.api(`/api/tokens/${revoked.id}`, { method: "DELETE" })).status).toBe(204);
    const expired = await t.a.mcpToken("expired");
    await t.pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    const ping = (tok: string) => fetch(`${t.url}/api/agent/ping`, { headers: agentHeaders(tok) });
    expect((await ping(live.token)).status).toBe(200);
    const baseline = await shape(await ping("mn_" + "A".repeat(43)));
    expect(baseline.status).toBe(401);
    expect(await shape(await ping(revoked.token))).toEqual(baseline);
    expect(await shape(await ping(expired.token))).toEqual(baseline);
    await t.pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [t.a.id]);
    expect(await shape(await ping(live.token))).toEqual(baseline);
  });

  it("failed credentials fill the agent limiter: 429 too_many_failed_attempts + Retry-After; the other surfaces are unaffected", async () => {
    const s = await startTestServer({ agentFailureLimiter: createFailureLimiter({ max: 2, windowMs: 60_000 }) });
    try {
      const bad = () => fetch(`${s.url}/api/agent/ping`, { headers: agentHeaders("mn_" + "B".repeat(43)) });
      expect((await bad()).status).toBe(401);
      expect((await bad()).status).toBe(401);
      const r = await bad();
      expect(r.status).toBe(429);
      expect((await body(r)).error.code).toBe("too_many_failed_attempts");
      expect(r.headers.get("retry-after")).toBe("60");
      expect((await s.a.api("/api/state")).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe("isolation and guards", () => {
  it("user B's token never sees or touches user A's memories", async () => {
    const idA = await savedMemory("A secret", "A body", t);
    const { token: tokB } = await t.b.mcpToken();
    const { token: tokA } = await t.a.mcpToken();
    expect((await body(await agentPost(t.url, tokB, "memory_list", {}))).memories).toEqual([]);
    expect((await agentPost(t.url, tokB, "memory_read", { id: idA })).status).toBe(404);
    expect((await agentPost(t.url, tokB, "memory_update", { id: idA, title: "pwn" })).status).toBe(404);
    expect((await agentPost(t.url, tokB, "memory_archive", { id: idA })).status).toBe(404);
    expect((await body(await agentPost(t.url, tokB, "memory_search", { query: "secret" }))).total).toBe(0);
    const saved = await body(await agentPost(t.url, tokB, "memory_save", { title: "B note" }));
    expect((await stateOf()).state.revisions[saved.revisionId]).toBeUndefined(); // not in A's workspace
    expect((await body(await agentPost(t.url, tokA, "memory_status", {}))).pending.total).toBe(0);
  });

  it("the write limit is per user and shared by all of that user's tokens; reads are not counted against it", async () => {
    const s = await startTestServer({ limiter: createRateLimiter({ max: 2 }) });
    try {
      const t1 = (await s.a.mcpToken()).token;
      const t2 = (await s.a.mcpToken()).token;
      const tb = (await s.b.mcpToken()).token;
      expect((await agentPost(s.url, t1, "memory_save", { title: "1" })).status).toBe(200);
      expect((await agentPost(s.url, t2, "memory_save", { title: "2" })).status).toBe(200);
      const over = await agentPost(s.url, t1, "memory_save", { title: "3" });
      expect(over.status).toBe(429);
      expect((await body(over)).error.code).toBe("rate_limited");
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect((await agentPost(s.url, t1, "memory_status", {})).status).toBe(200);
      expect((await agentPost(s.url, tb, "memory_save", { title: "B" })).status).toBe(200); // other user: own bucket
    } finally {
      await s.close();
    }
  });

  it("the read limit is per user", async () => {
    const s = await startTestServer({ readLimiter: createRateLimiter({ max: 2, noun: "reads" }) });
    try {
      const ta = (await s.a.mcpToken()).token;
      const tb = (await s.b.mcpToken()).token;
      expect((await agentPost(s.url, ta, "memory_status", {})).status).toBe(200);
      expect((await agentPost(s.url, ta, "memory_list", {})).status).toBe(200);
      const over = await agentPost(s.url, ta, "memory_list", {});
      expect(over.status).toBe(429);
      expect((await body(over)).error.code).toBe("rate_limited");
      expect(over.headers.get("retry-after")).toBeTruthy();
      expect((await agentPost(s.url, tb, "memory_list", {})).status).toBe(200);
      expect((await fetch(`${s.url}/api/agent/ping`, { headers: agentHeaders(ta) })).status).toBe(200); // ping is not a read
    } finally {
      await s.close();
    }
  });

  it("the inbox cap gives 429 inbox_full, but refining an existing proposal is still allowed", async () => {
    const s = await startTestServer({ maxPending: 2 });
    try {
      const tok = (await s.a.mcpToken()).token;
      const first = await body(await agentPost(s.url, tok, "memory_save", { title: "1" }));
      expect((await agentPost(s.url, tok, "memory_save", { title: "2" })).status).toBe(200);
      const full = await agentPost(s.url, tok, "memory_save", { title: "3" });
      expect(full.status).toBe(429);
      const fb = await body(full);
      expect(fb.error.code).toBe("inbox_full");
      expect(fb.error.message).toMatch(/Ask the user/);
      expect((await agentPost(s.url, tok, "memory_update", { id: first.memoryId, title: "1 refined" })).status).toBe(200);
      expect((await body(await agentPost(s.url, tok, "memory_status", {}))).pending.inboxCap).toBe(2);
    } finally {
      await s.close();
    }
  });

  it("audits agent calls via mcp with the user id and client name, never content or the token", async () => {
    const { token } = await t.a.mcpToken();
    await agentPost(t.url, token, "memory_save", { title: "AUDITSECRET", content: "AUDITBODY" }, { "X-Mnemonis-Client": "audit-agent" });
    await agentPost(t.url, token, "memory_read", { id: "mem_nope" }, { "X-Mnemonis-Client": "audit-agent" });
    await t.audit.flush();
    const rows = (await t.pool.query("SELECT * FROM audit_log WHERE user_id = $1 AND via = 'mcp' ORDER BY id", [t.a.id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: "memory_save", ok: true, client: "audit-agent" });
    expect(rows[1]).toMatchObject({ action: "memory_read", ok: false, code: "memory_not_found" });
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("AUDIT" + "SECRET");
    expect(dump).not.toContain("AUDITBODY");
    expect(dump).not.toContain(token);
  });
});

describe("adapter secret (X-Forwarded-For on /api/agent/*)", () => {
  const SECRET = "t".repeat(24);
  const hdr = (ip: string, secret?: string) => ({ "X-Forwarded-For": ip, ...(secret ? { "X-Mnemonis-Adapter-Secret": secret } : {}) });
  const bad = (s: TestServer, h: Record<string, string>) => fetch(`${s.url}/api/agent/ping`, { headers: { ...agentHeaders("mn_" + "A".repeat(43)), ...h } });

  it("with the secret, two clients with different IPs do not share a failure bucket", async () => {
    const s = await startTestServer({ adapterSecret: SECRET, agentFailureLimiter: createFailureLimiter({ max: 2 }) });
    try {
      for (let i = 0; i < 2; i++) expect((await bad(s, hdr("1.1.1.1", SECRET))).status).toBe(401);
      expect((await bad(s, hdr("1.1.1.1", SECRET))).status).toBe(429);
      expect((await bad(s, hdr("2.2.2.2", SECRET))).status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it("without the secret (or a wrong one) a spoofed X-Forwarded-For does not escape the socket bucket", async () => {
    for (const secret of [undefined, "u".repeat(24)]) {
      const s = await startTestServer({ adapterSecret: SECRET, agentFailureLimiter: createFailureLimiter({ max: 2 }) });
      try {
        for (let i = 0; i < 2; i++) expect((await bad(s, hdr("1.1.1.1", secret))).status).toBe(401);
        expect((await bad(s, hdr("2.2.2.2", secret))).status).toBe(429);
      } finally {
        await s.close();
      }
    }
  });

  it("unset secret: the header is ignored", async () => {
    const s = await startTestServer({ agentFailureLimiter: createFailureLimiter({ max: 2 }) });
    try {
      for (let i = 0; i < 2; i++) expect((await bad(s, hdr("1.1.1.1", SECRET))).status).toBe(401);
      expect((await bad(s, hdr("2.2.2.2", SECRET))).status).toBe(429);
    } finally {
      await s.close();
    }
  });

  it("is not honoured on the web-facing /api routes, even with the right secret", async () => {
    const s = await startTestServer({ adapterSecret: SECRET, failureLimiter: createFailureLimiter({ max: 2 }) });
    try {
      const call = (ip: string) => fetch(`${s.url}/api/state`, { headers: hdr(ip, SECRET) });
      for (let i = 0; i < 2; i++) expect((await call("1.1.1.1")).status).toBe(401);
      expect((await call("2.2.2.2")).status).toBe(429);
    } finally {
      await s.close();
    }
  });
});
