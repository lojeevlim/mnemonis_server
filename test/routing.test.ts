import { afterEach, beforeEach, describe as baseDescribe, expect, it, vi } from "vitest";
import { createPgAudit } from "../src/audit.js";
import { createFailureLimiter } from "../src/http/auth.js";
import { agentPost, rawRequest, startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

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
const raw = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  rawRequest(t.port, { path, method, host: `127.0.0.1:${t.port}`, headers });

/** Status, headers (minus Date) and body: everything that could tell refusals apart. */
async function shape(r: Response) {
  const headers = [...r.headers.entries()].filter(([k]) => k !== "date").sort(([a], [b]) => a.localeCompare(b));
  return { status: r.status, body: await r.text(), headers };
}

describe("routing quirks are pinned", () => {
  it("paths that look like /api/health but are not it need credentials (401)", async () => {
    expect((await raw("/api/health")).status).toBe(200);
    for (const [path, method] of [
      ["/api/health/", "GET"],
      ["/api/healthx", "GET"],
      ["/api/health", "POST"],
      ["/api/health", "PUT"],
      ["/api/health/x", "GET"],
    ] as const) {
      const r = await raw(path, method);
      expect({ path, method, status: r.status }).toEqual({ path, method, status: 401 });
      expect(r.body).not.toContain("ok");
    }
  });

  it("a dot-segment path cannot reach an authenticated route without credentials", async () => {
    // sent verbatim (fetch would normalise it away)
    const r = await raw("/api/tokens/../state");
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error.code).toBe("unauthorized");
    // Dot segments are resolved by the server; /api/tokens/../health is simply the public health route.
    const health = await raw("/api/tokens/../health");
    expect(health).toEqual(await raw("/api/health"));
  });

  it("routing is case-sensitive and strict about trailing slashes: /API/state, /mcp/, /MCP are 404", async () => {
    for (const path of ["/API/state", "/API/health", "/mcp/", "/MCP"]) {
      const r = await raw(path);
      expect({ path, status: r.status }).toEqual({ path, status: 404 });
      expect(JSON.parse(r.body)).toEqual({ error: { code: "not_found", message: "Not found" } });
    }
  });

  it("HEAD on authenticated routes without credentials is 401, never data", async () => {
    for (const path of ["/api/state", "/api/export", "/api/me", "/api/tokens", "/api/agent/ping"]) {
      const r = await fetch(`${t.url}${path}`, { method: "HEAD" });
      expect({ path, status: r.status }).toEqual({ path, status: 401 });
      expect(r.headers.get("www-authenticate")).toBe('Bearer realm="mnemonis"');
    }
  });

  it("preflight (OPTIONS, incl. the DELETE preflight) is 204 for an allowed origin and 403 for a disallowed one", async () => {
    const origin = "http://localhost:5173";
    for (const [path, method] of [["/api/state", "PUT"], ["/api/tokens/abc", "DELETE"], ["/api/tokens", "POST"]] as const) {
      const ok = await fetch(`${t.url}${path}`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization" },
      });
      expect({ path, status: ok.status }).toEqual({ path, status: 204 });
      expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
      expect(ok.headers.get("access-control-allow-methods")).toContain(method);
      const bad = await fetch(`${t.url}${path}`, {
        method: "OPTIONS",
        headers: { Origin: "http://evil.example", "Access-Control-Request-Method": method },
      });
      expect({ path, status: bad.status }).toEqual({ path, status: 403 });
      expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("401 responses are byte-identical across doors and failure reasons", () => {
  it("/api/*, /api/agent/* and HEAD give the same status, headers (minus Date and the agent's request id/contract) and body", async () => {
    const api = await shape(await fetch(`${t.url}/api/state`));
    const agentHeaders = { "X-Mnemonis-Contract": "1" };
    const agentShape = async (r: Response) => {
      const s = await shape(r);
      return { ...s, headers: s.headers.filter(([k]) => k !== "x-request-id" && k !== "x-mnemonis-contract") };
    };
    const agent = await agentShape(await fetch(`${t.url}/api/agent/ping`, { headers: agentHeaders }));
    expect(api.status).toBe(401);
    expect(agent).toEqual(api);
    const garbageApi = await shape(await fetch(`${t.url}/api/state`, { headers: { Authorization: "Bearer a.b.c" } }));
    const garbageAgent = await agentShape(await fetch(`${t.url}/api/agent/ping`, { headers: { ...agentHeaders, Authorization: `Bearer mn_${"A".repeat(43)}` } }));
    expect(garbageApi).toEqual(api);
    expect(garbageAgent).toEqual(api);
    const head = await fetch(`${t.url}/api/state`, { method: "HEAD" });
    expect(head.status).toBe(401);
    expect(await head.text()).toBe("");
    expect(head.headers.get("www-authenticate")).toBe(Object.fromEntries(api.headers)["www-authenticate"]);
  });
});

describe("oversize bodies are refused with 413", () => {
  it("POST /api/tokens over 16 KiB", async () => {
    const r = await t.a.api("/api/tokens", { method: "POST", headers: json, body: JSON.stringify({ label: "x".repeat(16 * 1024 + 1) }) });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: { code: "too_large", message: "Request body is too large" } });
    const small = await t.a.api("/api/tokens", { method: "POST", headers: json, body: JSON.stringify({ label: "ok" }) });
    expect(small.status).toBe(201);
  });

  it("POST /api/agent/memory/save over 512 KiB", async () => {
    const { token } = await t.a.mcpToken();
    const r = await agentPost(t.url, token, "memory_save", JSON.stringify({ title: "x", content: "x".repeat(512 * 1024 + 1) }));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: { code: "too_large", message: "Request body is too large" } });
  });

  it("PUT /api/state over the import limit", async () => {
    const r = await t.a.api("/api/state", { method: "PUT", headers: { ...json, "If-Match": '"1"' }, body: "x".repeat(10 * 1024 * 1024 + 1) });
    expect(r.status).toBe(413);
  });
});

describe("credential-backend outages", () => {
  it("a failing session lookup answers 503 with the unavailable body and never consumes the failure budget", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const limiter = createFailureLimiter({ max: 2 });
    const s = await start({
      failureLimiter: limiter,
      accounts: (real) => ({ ...real, verifySession: async () => { throw new Error("db down"); } }),
    });
    const bodies = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const r = await s.a.api("/api/state");
      expect(r.status).toBe(503);
      expect(r.headers.get("www-authenticate")).toBeNull();
      bodies.add(await r.text());
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: "unavailable", message: "Service unavailable" } })]);
    // never 429: the outage did not count against this client
    expect(limiter.blocked("127.0.0.1")).toBe(false);
    // and a real refusal still counts (budget intact)
    expect((await fetch(`${s.url}/api/state`)).status).toBe(401);
  });
});

describe("audit failure isolation", () => {
  it("a row whose user is gone (FK violation) is re-inserted with user_id NULL instead of being dropped; the rest of the batch is kept", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const audit = createPgAudit(t.pool);
    await t.pool.query("DELETE FROM audit_log WHERE action = 'iso-bad'");
    const ghost = "00000000-0000-4000-8000-0000000000aa";
    const row = (userId: string, action: string) => ({ userId, via: "rest" as const, client: "c", action, ok: true });
    audit.record(row(t.a.id, "iso1"));
    audit.record(row(ghost, "iso-bad"));
    audit.record(row(t.a.id, "iso2"));
    await audit.flush();
    expect(audit.dropped()).toBe(0);
    const rows = await t.pool.query("SELECT action FROM audit_log WHERE user_id = $1 AND action LIKE 'iso%' ORDER BY action", [t.a.id]);
    expect(rows.rows.map((r) => r.action)).toEqual(["iso1", "iso2"]);
    const orphan = await t.pool.query("SELECT user_id, ok FROM audit_log WHERE action = 'iso-bad'");
    expect(orphan.rows).toEqual([{ user_id: null, ok: true }]);
    await t.pool.query("DELETE FROM audit_log WHERE action = 'iso-bad'");
  });
});
