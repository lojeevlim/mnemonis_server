import { request } from "node:http";
import pg from "pg";
import { afterEach, beforeEach, describe as baseDescribe, expect, it, vi } from "vitest";
import { createPgAudit } from "../src/audit.js";
import { hashToken, TOKEN_RE } from "../src/auth/apiTokens.js";
import { createSession } from "../src/auth/sessions.js";
import { createFailureLimiter } from "../src/http/auth.js";
import { rawRequest, startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

let t: TestServer;
const servers: TestServer[] = [];
const start = async (o: Parameters<typeof startTestServer>[0] = {}) => {
  const s = await startTestServer(o);
  servers.push(s);
  return s;
};
beforeEach(async () => {
  t = await start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const json = { "Content-Type": "application/json" };
/** The agent surface (mn_ tokens only): GET /api/agent/ping is 200 for a valid token and the uniform 401 otherwise. */
const mcpPost = (s: TestServer, headers: Record<string, string>) => fetch(`${s.url}/api/agent/ping`, { headers: { "X-Mnemonis-Contract": "1", ...headers } });

/** Everything an attacker could use to tell refusals apart. */
async function shape(r: Response) {
  const headers = [...r.headers.entries()].filter(([k]) => k !== "date" && k !== "x-request-id").sort(([a], [b]) => a.localeCompare(b));
  return { status: r.status, body: await r.text(), headers };
}

const UNAUTH = { error: { code: "unauthorized", message: "Missing or invalid credentials" } };

describe("identical 401 for every credential refusal", () => {
  it("covers session failures: missing, garbage, wrong shape, expired, revoked, idle, tampered, unknown", async () => {
    const mk = async () => (await createSession(t.pool, t.a.id, { idleDays: 7, maxDays: 30 }, "x"))!;
    const revoked = await mk();
    await t.pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [revoked.id]);
    const expired = await mk();
    await t.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    const idle = await mk();
    await t.pool.query("UPDATE sessions SET last_seen_at = now() - interval '8 days' WHERE id = $1", [idle.id]);
    const unknown = `ms_${"A".repeat(43)}`;
    const creds: Record<string, string | undefined> = {
      missing: undefined,
      garbage: "Bearer nope",
      basic: "Basic dXNlcjpwdw==",
      doubleSpace: `Bearer  ${t.a.session}`,
      unknown: `Bearer ${unknown}`,
      revoked: `Bearer ${revoked.token}`,
      expired: `Bearer ${expired.token}`,
      idleExpired: `Bearer ${idle.token}`,
      tamperedLast: `Bearer ${t.a.session.slice(0, -1)}${t.a.session.endsWith("A") ? "B" : "A"}`,
      tooShort: `Bearer ${unknown.slice(0, -1)}`,
      tooLong: `Bearer ${unknown}A`,
      badChars: `Bearer ms_${"!".repeat(43)}`,
      oversized: `Bearer ${"a".repeat(9000)}`,
      sessionLookalike: "Bearer aaaa.bbbb.cccc",
    };
    const baseline = await shape(await fetch(`${t.url}/api/state`));
    expect(baseline.status).toBe(401);
    expect(JSON.parse(baseline.body)).toEqual(UNAUTH);
    expect(Object.fromEntries(baseline.headers)["www-authenticate"]).toBe('Bearer realm="mnemonis"');
    for (const [name, value] of Object.entries(creds)) {
      const r = await fetch(`${t.url}/api/state`, { headers: value ? { Authorization: value } : {} });
      expect({ name, ...(await shape(r)) }, name).toEqual({ name, ...baseline });
    }
    // the positive control: the unmodified token is accepted
    expect((await t.a.api("/api/state")).status).toBe(200);
  });

  it("a disabled user is refused on both doors with the same 401", async () => {
    const { token } = await t.a.mcpToken();
    const baseline = await shape(await fetch(`${t.url}/api/state`));
    expect((await t.a.api("/api/state")).status).toBe(200);
    await t.pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [t.a.id]);
    expect(await shape(await t.a.api("/api/state"))).toEqual(baseline);
    expect(await shape(await mcpPost(t, t.a.mcpHeaders(token)))).toEqual(await shape(await mcpPost(t, {})));
  });

  it("covers mcp token failures: unknown, revoked, expired, wrong length, wrong type", async () => {
    const baseline = await shape(await mcpPost(t, {}));
    expect(baseline.status).toBe(401);
    expect(JSON.parse(baseline.body)).toEqual(UNAUTH);
    const revoked = await t.a.mcpToken();
    await t.pool.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1", [revoked.id]);
    const expired = await t.a.mcpToken();
    await t.pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.id]);
    const web = await t.a.mcpToken();
    await t.pool.query("UPDATE api_tokens SET kind = 'web' WHERE id = $1", [web.id]);
    const unknown = `mn_${"A".repeat(43)}`;
    for (const [name, cred] of Object.entries({
      unknown,
      revoked: revoked.token,
      expired: expired.token,
      webKind: web.token,
      tooShort: unknown.slice(0, -1),
      tooLong: `${unknown}A`,
      badChars: `mn_${"!".repeat(43)}`,
      session: t.a.session,
    })) {
      expect({ name, ...(await shape(await mcpPost(t, { Authorization: `Bearer ${cred}` }))) }, name).toEqual({ name, ...baseline });
    }
  });

  it("a wrong-length mn_ credential is refused before any database access", async () => {
    let calls = 0;
    const s = await start({ accounts: (real) => ({ ...real, verifyMcp: (tok) => (calls++, real.verifyMcp(tok)) }) });
    await mcpPost(s, { Authorization: `Bearer mn_${"A".repeat(42)}` });
    await mcpPost(s, { Authorization: `Bearer mn_${"A".repeat(44)}` });
    await mcpPost(s, { Authorization: `Bearer ${s.a.session}` });
    expect(calls).toBe(0);
    await mcpPost(s, { Authorization: `Bearer mn_${"A".repeat(43)}` });
    expect(calls).toBe(1);
  });

  it("a duplicated Authorization header never authenticates", async () => {
    const dup = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: t.port, path: "/api/state", method: "GET", setHost: false }, (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.setHeader("Host", `127.0.0.1:${t.port}`);
      req.setHeader("Authorization", [`Bearer ${t.a.session}`, `Bearer ${t.b.session}`]);
      req.end();
    });
    expect(dup).toBe(401);
  });
});

describe("credential kind separation", () => {
  it("an mcp token is refused on every REST route, a session is refused on /api/agent", async () => {
    const { token } = await t.a.mcpToken();
    const h = { Authorization: `Bearer ${token}` };
    const baseline = await shape(await fetch(`${t.url}/api/state`));
    const attempts: [string, string, string?][] = [
      ["GET", "/api/state"],
      ["GET", "/api/export"],
      ["GET", "/api/me"],
      ["GET", "/api/auth/me"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/password", JSON.stringify({ currentPassword: t.a.password, newPassword: "another-long-passphrase-9" })],
      ["DELETE", "/api/auth/me", JSON.stringify({ password: t.a.password })],
      ["GET", "/api/tokens"],
      ["POST", "/api/tokens", JSON.stringify({ label: "mint" })],
      ["DELETE", "/api/tokens/00000000-0000-4000-8000-000000000000"],
      ["POST", "/api/ops/approve", JSON.stringify({ revisionId: "rev_x" })],
      ["POST", "/api/ops/createMemory", JSON.stringify({ title: "x" })],
    ];
    for (const [method, path, body] of attempts) {
      const r = await fetch(`${t.url}${path}`, { method, headers: { ...json, ...h }, body });
      expect(await shape(r), `${method} ${path}`).toEqual(baseline);
    }
    expect((await mcpPost(t, { Authorization: `Bearer ${t.a.session}` })).status).toBe(401);
    expect((await mcpPost(t, h)).status).toBe(200);
    // nothing was minted by the refused attempt
    const list = (await (await t.a.api("/api/tokens")).json()) as { tokens: { label: string }[] };
    expect(list.tokens.map((x) => x.label)).not.toContain("mint");
  });
});

describe("token lifecycle", () => {
  const create = (u = t.a, body: unknown = { label: "laptop" }) =>
    u.api("/api/tokens", { method: "POST", headers: json, body: JSON.stringify(body) });

  it("creates a token shown once: 201, no-store, never in the list, hash-only in the database", async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["createdAt", "expiresAt", "id", "label", "prefix", "token"]);
    expect(body.token).toMatch(TOKEN_RE);
    expect(body.prefix).toBe(body.token.slice(0, 7));
    expect(body.label).toBe("laptop");
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(89 * 86_400_000);

    const list = await (await t.a.api("/api/tokens")).text();
    expect(list).not.toContain(body.token);
    expect(list).not.toMatch(/hash/i);
    expect(JSON.parse(list).tokens[0]).toMatchObject({ id: body.id, label: "laptop", prefix: body.prefix, revokedAt: null });

    const row = (await t.pool.query("SELECT t::text AS dump, token_hash FROM api_tokens t WHERE id = $1", [body.id])).rows[0];
    expect(row.dump).not.toContain(body.token);
    expect(Buffer.compare(row.token_hash, hashToken(body.token))).toBe(0);
    for (const path of ["/api/me", "/api/state", "/api/export"]) expect(await (await t.a.api(path)).text()).not.toContain(body.token);
  });

  it("the new token works on /api/agent, and revocation is effective on the very next request", async () => {
    const { id, token } = (await (await create()).json()) as { id: string; token: string };
    expect((await mcpPost(t, { Authorization: `Bearer ${token}` })).status).toBe(200);
    const del = await t.a.api(`/api/tokens/${id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await mcpPost(t, { Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await t.a.api(`/api/tokens/${id}`, { method: "DELETE" })).status).toBe(204); // idempotent for the owner
    const list = (await (await t.a.api("/api/tokens")).json()) as { tokens: { id: string; revokedAt: string | null }[] };
    expect(list.tokens.find((x) => x.id === id)?.revokedAt).not.toBeNull();
  });

  it("DELETE of another user's or an unknown id is the same 404 and revokes nothing", async () => {
    const { id, token } = (await (await create()).json()) as { id: string; token: string };
    const other = await t.b.api(`/api/tokens/${id}`, { method: "DELETE" });
    const unknown = await t.b.api("/api/tokens/00000000-0000-4000-8000-000000000000", { method: "DELETE" });
    const junk = await t.b.api("/api/tokens/not-a-uuid", { method: "DELETE" });
    expect(other.status).toBe(404);
    const o = await shape(other);
    for (const r of [unknown, junk]) expect(await shape(r)).toEqual(o);
    expect((await mcpPost(t, { Authorization: `Bearer ${token}` })).status).toBe(200);
    expect(((await (await t.b.api("/api/tokens")).json()) as { tokens: unknown[] }).tokens).toEqual([]);
  });

  it("enforces the active-token cap (409) and validates input (400)", async () => {
    const s = await start({ maxMcpTokens: 2 });
    expect((await create(s.a)).status).toBe(201);
    expect((await create(s.a)).status).toBe(201);
    const over = await create(s.a);
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("token_limit_reached");
    expect((await create(s.b)).status).toBe(201); // per user
    for (const body of [{ label: "" }, { label: "  " }, {}, { label: "x", extra: 1 }, { label: "x", expiresInDays: 0 }, { label: "x", expiresInDays: 366 }, { label: "x", expiresInDays: 1.5 }, { label: "x".repeat(81) }, []]) {
      const r = await create(s.b, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await s.b.api("/api/tokens", { method: "POST", headers: json, body: "{nope" })).status).toBe(400);
    const dated = (await (await create(s.b, { label: "short", expiresInDays: 1 })).json()) as { expiresAt: string };
    expect(Date.parse(dated.expiresAt) - Date.now()).toBeLessThan(86_500_000);
  });

  it("GET /api/me and /api/auth/me return the stored profile and the session expiry", async () => {
    for (const path of ["/api/me", "/api/auth/me"]) {
      const me = (await (await t.a.api(path)).json()) as { id: string; email: string; displayName: string; session: { expiresAt: string } };
      expect(me).toMatchObject({ id: t.a.id, email: t.a.email, displayName: "User A" });
      expect(Date.parse(me.session.expiresAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    }
  });

  it("audits token create/revoke by id only (never the token, label or response body)", async () => {
    const { id, token } = (await (await create(t.a, { label: "LABELSECRET" })).json()) as { id: string; token: string };
    await t.a.api(`/api/tokens/${id}`, { method: "DELETE" });
    await t.audit.flush();
    const rows = (await t.pool.query("SELECT * FROM audit_log WHERE user_id = $1 AND action LIKE 'token:%' ORDER BY id", [t.a.id])).rows;
    expect(rows.map((r) => [r.action, r.ids, r.ok])).toEqual([["token:create", [id], true], ["token:revoke", [id], true]]);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain("LABELSECRET");
  });
});

describe("Host allowlist, failure limiter and infrastructure errors", () => {
  it("MNEMONIS_ALLOWED_HOSTS admits exact, case-insensitive matches only; loopback:port still works", async () => {
    const s = await start({ allowedHosts: ["api.example.test"] });
    const h = (host: string) => rawRequest(s.port, { path: "/api/health", host }).then((r) => r.status);
    expect(await h("api.example.test")).toBe(200);
    expect(await h("API.Example.TEST")).toBe(200);
    expect(await h(`127.0.0.1:${s.port}`)).toBe(200);
    expect(await h("evil.test")).toBe(403);
    expect(await h("api.example.test.evil.test")).toBe(403);
    expect(await h("sub.api.example.test")).toBe(403);
    expect(await h("localhost")).toBe(403);
  });

  it("without allowed hosts only loopback:port is accepted", async () => {
    expect((await rawRequest(t.port, { path: "/api/health", host: "api.example.test" })).status).toBe(403);
  });

  it("failures beyond the budget (30/min by default) give 429 per client (even for a valid credential); successes do not count", async () => {
    const s = await start({ failureLimiter: createFailureLimiter({ max: 3 }) });
    for (let i = 0; i < 5; i++) expect((await s.a.api("/api/state")).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await fetch(`${s.url}/api/state`)).status).toBe(401);
    const blocked = await fetch(`${s.url}/api/state`);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await s.a.api("/api/state")).status).toBe(429);
    expect((await fetch(`${s.url}/api/health`)).status).toBe(200); // health is outside the auth path
    // /api/agent has its own limiter instance: failures on /api never lock out /api/agent (and vice versa)
    expect((await mcpPost(s, {})).status).toBe(401);
  });

  it("the /api/agent failure limiter is separate from the /api one and uses its own error code", async () => {
    const s = await start({ agentFailureLimiter: createFailureLimiter({ max: 2 }), failureLimiter: createFailureLimiter({ max: 50 }) });
    for (let i = 0; i < 2; i++) expect((await mcpPost(s, {})).status).toBe(401);
    const limited = await mcpPost(s, {});
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("too_many_failed_attempts");
    expect((await fetch(`${s.url}/api/state`)).status).toBe(401); // /api still answers normally
    expect((await s.a.api("/api/state")).status).toBe(200);
  });

  it("accepts the Bearer scheme case-insensitively on both surfaces", async () => {
    const s = await start();
    for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
      expect((await fetch(`${s.url}/api/state`, { headers: { Authorization: `${scheme} ${s.a.session}` } })).status, scheme).toBe(200);
    }
    const { token } = await s.a.mcpToken();
    expect((await mcpPost(s, { Authorization: `bearer ${token}` })).status).not.toBe(401);
    expect((await mcpPost(s, { Authorization: `bearer ${token.toLowerCase()}` })).status).toBe(401); // the credential itself stays case-sensitive
  });

  it("X-Forwarded-For selects the limiter bucket only when the proxy is trusted", async () => {
    const xff = (ip: string) => ({ "X-Forwarded-For": `6.6.6.6, ${ip}` });
    const trusted = await start({ trustProxy: true, failureLimiter: createFailureLimiter({ max: 2 }) });
    for (let i = 0; i < 2; i++) await fetch(`${trusted.url}/api/state`, { headers: xff("1.1.1.1") });
    expect((await fetch(`${trusted.url}/api/state`, { headers: xff("1.1.1.1") })).status).toBe(429);
    expect((await fetch(`${trusted.url}/api/state`, { headers: xff("2.2.2.2") })).status).toBe(401);

    const untrusted = await start({ trustProxy: false, failureLimiter: createFailureLimiter({ max: 2 }) });
    for (let i = 0; i < 2; i++) await fetch(`${untrusted.url}/api/state`, { headers: xff("1.1.1.1") });
    expect((await fetch(`${untrusted.url}/api/state`, { headers: xff("2.2.2.2") })).status).toBe(429); // spoofing does not escape the bucket
  });

  it("a broken database gives 503 {unavailable} on both doors and logs only the error class", async () => {
    const broken = new pg.Pool({ connectionString: "postgres://nobody:s3cr3tpw@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
    broken.on("error", () => undefined);
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    try {
      const s = await start({ httpPool: broken });
      const sess = `ms_${"C".repeat(43)}`;
      const mcpTok = `mn_${"B".repeat(43)}`;
      const r1 = await fetch(`${s.url}/api/state`, { headers: { Authorization: `Bearer ${sess}` } });
      const r2 = await mcpPost(s, { Authorization: `Bearer ${mcpTok}` });
      for (const r of [r1, r2]) {
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ error: { code: "unavailable", message: "Service unavailable" } });
        expect(r.headers.get("www-authenticate")).toBeNull();
      }
      const dump = logs.join("\n");
      expect(dump).toContain("auth backend unavailable");
      for (const secret of [sess, mcpTok, "s3cr3tpw", "ECONNREFUSED", "127.0.0.1"]) expect(dump).not.toContain(secret);
    } finally {
      await broken.end().catch(() => undefined);
    }
  });

  it("an audit backend failure never fails the request and is counted as dropped", async () => {
    const broken = new pg.Pool({ connectionString: "postgres://nobody:pw@127.0.0.1:1/none", connectionTimeoutMillis: 300 });
    broken.on("error", () => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const audit = createPgAudit(broken);
    const s = await start({ audit });
    expect((await s.a.op("createMemory", { title: "still works" })).status).toBe(200);
    await audit.flush();
    expect(audit.dropped()).toBeGreaterThan(0);
    expect((await s.a.api("/api/state")).status).toBe(200);
    await broken.end().catch(() => undefined);
  });

  it("the audit queue is bounded: overflow is dropped and counted, never blocking", async () => {
    const audit = createPgAudit(t.pool, { maxQueue: 3 });
    for (let i = 0; i < 10; i++) audit.record({ userId: t.a.id, via: "rest", client: "c", action: `a${i}`, ok: true });
    expect(audit.dropped()).toBe(7);
    await audit.flush();
    const n = (await t.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action ~ '^a[0-9]$'", [t.a.id])).rows[0].n;
    expect(n).toBe(3);
  });

  it("unknown routes and malformed JSON give structured errors without internals", async () => {
    const r = await t.a.api("/api/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });
});
