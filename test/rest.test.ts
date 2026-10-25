import { afterEach, beforeEach, describe as baseDescribe, expect, it } from "vitest";
import { MAX_IMPORT_BYTES } from "../src/domain/index.js";
import { rawRequest, startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

let t: TestServer;
beforeEach(async () => {
  t = await startTestServer();
});
afterEach(() => t.close());

const ORIGIN = "http://localhost:5173";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${t.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("authentication", () => {
  it("health is public, exactly {ok:true}, and exposes no data", async () => {
    await t.op("createMemory", { title: "Secret title" });
    const r = await fetch(`${t.url}/api/health`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain("Secret");
  });

  it("rejects missing and wrong credentials with 401 (state, export, ops, agent)", async () => {
    for (const [method, path] of [
      ["GET", "/api/state"],
      ["GET", "/api/export"],
      ["PUT", "/api/state"],
      ["POST", "/api/ops/createMemory"],
      ["POST", "/api/agent/memory/status"],
    ] as const) {
      expect((await fetch(`${t.url}${path}`, { method })).status).toBe(401);
      const wrong = await fetch(`${t.url}${path}`, { method, headers: { Authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("www-authenticate")).toContain("Bearer");
    }
  });

  it("the session token never appears in any response body or header", async () => {
    const responses = [
      await fetch(`${t.url}/api/health`),
      await t.api("/api/state"),
      await t.api("/api/export"),
      await t.op("createMemory", { title: "x" }),
      await t.op("nope"),
      await fetch(`${t.url}/api/state`, { headers: { Authorization: "Bearer wrong" } }),
      await fetch(`${t.url}/api/state`, { headers: { Origin: "http://evil.test", Authorization: `Bearer ${t.a.session}` } }),
    ];
    for (const r of responses) {
      const dump = JSON.stringify([...r.headers.entries()]) + (await r.text());
      expect(dump).not.toContain(t.a.session);
    }
  });

  it("every /api response is Cache-Control: no-store", async () => {
    for (const r of [await fetch(`${t.url}/api/health`), await fetch(`${t.url}/api/state`), await t.api("/api/state"), await t.api("/api/me")]) {
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("Host and Origin validation", () => {
  it("403 for a forged Host header (DNS rebinding), 200 for localhost forms", async () => {
    const h = { Authorization: `Bearer ${t.a.session}` };
    expect((await rawRequest(t.port, { path: "/api/health", host: "evil.test", headers: h })).status).toBe(403);
    expect((await rawRequest(t.port, { path: "/api/health", host: "localhost", headers: h })).status).toBe(403); // no port
    expect((await rawRequest(t.port, { path: "/api/health", host: `localhost:${t.port + 1}`, headers: h })).status).toBe(403);
    expect((await rawRequest(t.port, { path: "/api/health", host: `localhost:${t.port}`, headers: h })).status).toBe(200);
    expect((await rawRequest(t.port, { path: "/api/health", host: `127.0.0.1:${t.port}`, headers: h })).status).toBe(200);
    expect((await rawRequest(t.port, { path: "/api/agent/ping", host: "evil.test", headers: h })).status).toBe(403);
  });

  it("403 for a disallowed Origin on REST and /api/agent, even with a valid token", async () => {
    for (const path of ["/api/state", "/api/health", "/api/agent/ping"]) {
      const r = await fetch(`${t.url}${path}`, { headers: t.headers({ Origin: "http://evil.test" }) });
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await fetch(`${t.url}/api/state`, { headers: t.headers({ Origin: "null" }) })).status).toBe(403);
  });

  it("allowed Origin gets exact-match CORS headers and exposes ETag", async () => {
    const r = await fetch(`${t.url}/api/state`, { headers: t.headers({ Origin: ORIGIN }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("access-control-expose-headers")).toBe("ETag, Retry-After"); // the browser client must be able to read Retry-After on 429/503
    expect(r.headers.get("vary")).toContain("Origin");
  });
});

describe("CORS preflight", () => {
  const preflight = (origin: string) =>
    fetch(`${t.url}/api/ops/createMemory`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,if-match",
      },
    });

  it("allows the configured origin (204, no auth needed, never *)", async () => {
    const r = await preflight(ORIGIN);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
    expect(r.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type, If-Match, If-None-Match");
  });

  it("denies other origins", async () => {
    const r = await preflight("http://evil.test");
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("DELETE preflight (token revocation) is answered only for allowed origins", async () => {
    const del = (origin: string) =>
      fetch(`${t.url}/api/tokens/x`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization" },
      });
    const ok = await del(ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-methods")).toContain("DELETE");
    const bad = await del("http://evil.test");
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("state, ETag and If-Match", () => {
  it("GET /api/state returns {rev,state} with ETag, 304 on If-None-Match", async () => {
    const r = await t.api("/api/state");
    const body = (await r.json()) as { rev: number; state: { schemaVersion: number } };
    expect(body.rev).toBe(0);
    expect(body.state.schemaVersion).toBe(2);
    expect(r.headers.get("etag")).toBe('"0"');
    const again = await t.api("/api/state", { headers: { "If-None-Match": '"0"' } });
    expect(again.status).toBe(304);
  });

  it("PUT requires If-Match (428), stale gives 409, matching imports and bumps rev", async () => {
    await t.op("createMemory", { title: "one" }); // rev 1
    const exported = await (await t.api("/api/export")).text();
    const put = (ifMatch?: string, body = exported) =>
      t.api("/api/state", { method: "PUT", headers: ifMatch ? { "If-Match": ifMatch } : {}, body });
    expect((await put()).status).toBe(428);
    expect((await put("abc")).status).toBe(400);
    const stale = await put('"0"');
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { currentRev: number }).currentRev).toBe(1);
    const ok = await put('"1"');
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe('"2"');
    expect(((await ok.json()) as { rev: number }).rev).toBe(2);
    expect((await put('"2"', "{not json")).status).toBe(400);
    expect((await put('"2"', JSON.stringify({ state: { schemaVersion: 99 } }))).status).toBe(400);
  });

  it("export/import round trip preserves the workspace", async () => {
    await t.op("createMemory", { title: "Round trip", content: "body" });
    const exported = await (await t.api("/api/export")).text();
    expect(JSON.parse(exported).schemaVersion).toBe(2);
    await t.api("/api/state", { method: "PUT", headers: { "If-Match": '"1"' }, body: exported });
    const after = (await (await t.api("/api/state")).json()) as { state: unknown };
    expect(after.state).toEqual(JSON.parse(exported).state);
  });
});

describe("body limits", () => {
  it("413 for an ordinary op body over 1 MB", async () => {
    const r = await post("/api/ops/createMemory", { title: "x", content: "a".repeat(1_100_000) }, t.headers());
    expect(r.status).toBe(413);
  });

  it("413 for an import over MAX_IMPORT_BYTES", async () => {
    const r = await t.api("/api/state", {
      method: "PUT",
      headers: { "If-Match": '"0"' },
      body: "x".repeat(MAX_IMPORT_BYTES + 10),
    });
    expect(r.status).toBe(413);
  });
});

describe("ops", () => {
  it("unknown op is 404 (including prototype names)", async () => {
    expect((await t.op("dropEverything")).status).toBe(404);
    expect((await t.op("constructor")).status).toBe(404);
    expect((await t.op("toString")).status).toBe(404);
  });

  it("whitelist covers exactly the web repository mutations", async () => {
    const { OPS } = await import("../src/http/rest.js");
    expect(Object.keys(OPS).sort()).toEqual(
      [
        "createMemory", "updateMemory", "archiveMemory", "restoreMemory", "rollbackMemory",
        "addRelation", "removeRelation", "createCollection", "updateCollection", "deleteCollection",
        "approve", "reject", "approveRelation", "rejectRelation", "approveAll", "rejectAll",
        "approveAllDetailed", "rejectAllDetailed",
      ].sort(),
    );
  });

  it("a user create is saved at once and state reflects it ({rev,state,value})", async () => {
    const r = await t.op("createMemory", { title: "Hello", content: "World", tags: ["a"] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rev: number; value: { id: string; status: string }; state: { memories: Record<string, unknown> } };
    expect(body.rev).toBe(1);
    expect(body.value.status).toBe("saved");
    expect(Object.keys(body.state.memories)).toContain(body.value.id);
    const state = (await (await t.api("/api/state")).json()) as { rev: number };
    expect(state.rev).toBe(1);
  });

  type Created = { value: { id: string; status: string }; state: { revisions: Record<string, { author: string; origin: string; status: string }> } };

  it("an agent actor in the body downgrades a write to a pending proposal", async () => {
    const r = await t.op("createMemory", { title: "Health", actor: { kind: "agent", name: "memory-health" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Created;
    const rev = Object.values(body.state.revisions)[0];
    expect(rev.origin).toBe("agent");
    expect(rev.author).toBe("memory-health");
    expect(rev.status).toBe("pending");
  });

  it("agent actor works on update, archive and relations (pending), never upgrades", async () => {
    const agent = { kind: "agent", name: "memory-health" };
    const a = (await (await t.op("createMemory", { title: "A" })).json()) as Created;
    const b = (await (await t.op("createMemory", { title: "B" })).json()) as Created;
    const up = await t.op("updateMemory", { id: a.value.id, patch: { title: "A2" }, actor: agent });
    expect(up.status).toBe(200);
    const rel = (await (await t.op("addRelation", { fromId: a.value.id, toId: b.value.id, label: "x", actor: agent })).json()) as {
      value: { status: string };
    };
    expect(rel.value.status).toBe("pending");
    const arch = await t.op("archiveMemory", { id: b.value.id, actor: agent });
    expect(arch.status).toBe(200);
    const st = (await (await t.api("/api/state")).json()) as { state: { revisions: Record<string, { origin: string; status: string }> } };
    expect(Object.values(st.state.revisions).filter((r) => r.origin === "agent" && r.status === "pending").length).toBeGreaterThanOrEqual(2);
  });

  it("a user actor claim in the body is ignored: the server user is used", async () => {
    const r = await t.op("createMemory", { title: "Sneaky", actor: { kind: "user", name: "Somebody Else" } });
    const body = (await r.json()) as Created;
    expect(body.value.status).toBe("saved");
    const rev = Object.values(body.state.revisions)[0];
    expect(rev.origin).toBe("user");
    expect(rev.author).toBe("User A");
  });

  it("malformed actors are ignored (run as the server user, never an error, never an upgrade)", async () => {
    const bad: unknown[] = [
      null,
      "agent",
      [],
      { kind: "agent" },
      { kind: "agent", name: "" },
      { kind: "agent", name: "   " },
      { kind: "agent", name: 5 },
      { kind: "agent", name: "x".repeat(101) },
      { kind: "agent", name: "bad\u0007name" },
      { kind: "AGENT", name: "x" },
      { kind: "admin", name: "x" },
    ];
    for (const actor of bad) {
      const r = await t.op("createMemory", { title: "T", actor });
      expect(r.status).toBe(200);
      const body = (await r.json()) as Created;
      expect(body.value.status).toBe("saved");
    }
  });

  it("review ops ignore an agent actor in the body and run as the server user", async () => {
    const saved = (await (await t.op("createMemory", { title: "Base" })).json()) as Created;
    await t.service.updateMemory({ id: saved.value.id, patch: { title: "P1" }, actor: { kind: "agent", name: "bot" } });
    const find = async () => {
      const s = (await (await t.api("/api/state")).json()) as { state: { revisions: Record<string, { status: string; id: string }> } };
      return Object.values(s.state.revisions).find((r) => r.status === "pending");
    };
    const agent = { kind: "agent", name: "bot" };
    const ok = await t.op("approve", { revisionId: (await find())?.id, actor: agent });
    expect(ok.status).toBe(200);
    const other = (await (await t.op("createMemory", { title: "O" })).json()) as Created;
    const rel = (await (await t.op("addRelation", { fromId: saved.value.id, toId: other.value.id, label: "l", actor: agent })).json()) as {
      value: { id: string };
    };
    expect((await t.op("approveRelation", { relationId: rel.value.id, actor: agent })).status).toBe(200);
    expect((await t.op("removeRelation", { id: rel.value.id, actor: agent })).status).toBe(200);
    expect((await t.op("approveAll", { actor: agent })).status).toBe(200);
    expect((await t.op("rejectAll", { actor: agent })).status).toBe(200);
  });

  it("collection ops ignore the actor too", async () => {
    expect((await t.op("createCollection", { name: "C", actor: { kind: "agent", name: "x" } })).status).toBe(200);
  });

  it("the human actor name is the authenticated user's display name (and differs per user)", async () => {
    const mine = (await (await t.a.op("createMemory", { title: "x" })).json()) as { state: { revisions: Record<string, { author: string }> } };
    expect(Object.values(mine.state.revisions)[0].author).toBe("User A");
    const theirs = (await (await t.b.op("createMemory", { title: "y" })).json()) as { state: { revisions: Record<string, { author: string }> } };
    expect(Object.values(theirs.state.revisions)[0].author).toBe("User B");
  });

  it("rejects unknown keys and bad shapes with 400 (strict schemas)", async () => {
    expect((await t.op("createMemory", { title: "x", bogus: 1 })).status).toBe(400);
    expect((await t.op("createMemory", { title: 5 })).status).toBe(400);
    expect((await t.op("createMemory", {})).status).toBe(400);
    expect((await t.op("archiveMemory", { id: "" })).status).toBe(400);
    const bad = await fetch(`${t.url}/api/ops/createMemory`, { method: "POST", headers: t.headers(), body: "{nope" });
    expect(bad.status).toBe(400);
    const arr = await t.op("createMemory", [] as unknown as object);
    expect(arr.status).toBe(400);
  });

  it("maps domain errors to HTTP statuses without stacks or paths", async () => {
    const nf = await t.op("archiveMemory", { id: "mem_missing" });
    expect(nf.status).toBe(404);
    const body = (await nf.json()) as { error: { code: string } };
    expect(body.error.code).toBe("memory_not_found");
    const created = (await (await t.op("createMemory", { title: "A" })).json()) as { value: { id: string } };
    const b = (await (await t.op("createMemory", { title: "B" })).json()) as { value: { id: string } };
    expect((await t.op("addRelation", { fromId: created.value.id, toId: b.value.id, label: "x" })).status).toBe(200);
    const dup = await t.op("addRelation", { fromId: created.value.id, toId: b.value.id, label: "x" });
    expect(dup.status).toBe(409);
    expect((await t.op("approve", { revisionId: "rev_missing" })).status).toBe(404);
    const col = (await (await t.op("createCollection", { name: "C" })).json()) as { value: { id: string } };
    await t.op("updateMemory", { id: created.value.id, patch: { collectionId: col.value.id } });
    expect((await t.op("deleteCollection", { id: col.value.id })).status).toBe(409);
    const text = await (await t.op("archiveMemory", { id: "mem_missing" })).text();
    expect(text).not.toMatch(/\bat .*\(|\/Users\/|node_modules/);
  });

  it("review ops work through REST: approve an agent proposal", async () => {
    const saved = (await (await t.op("createMemory", { title: "Base" })).json()) as { value: { id: string } };
    await t.service.updateMemory({ id: saved.value.id, patch: { title: "Proposed" }, actor: { kind: "agent", name: "bot" } });
    const state = (await (await t.api("/api/state")).json()) as { state: { revisions: Record<string, { status: string; id: string }> } };
    const pending = Object.values(state.state.revisions).find((r) => r.status === "pending");
    expect(pending).toBeTruthy();
    const r = await t.op("approve", { revisionId: pending?.id });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { value: { status: string } }).value.status).toBe("saved");
  });

  const auditRows = async (userId: string) => {
    await t.audit.flush();
    return (await t.pool.query("SELECT * FROM audit_log WHERE user_id = $1 ORDER BY id", [userId])).rows;
  };

  it("writes an audit row with the user id and ids but no content", async () => {
    await t.op("createMemory", { title: "TOPSECRETTITLE", content: "TOPSECRETBODY" });
    const rows = await auditRows(t.a.id);
    expect(rows.at(-1)).toMatchObject({ via: "rest", action: "op:createMemory", ok: true, client: "User A", actor_kind: "user" });
    expect(rows.at(-1).ids[0]).toMatch(/^mem_/);
    expect(JSON.stringify(rows)).not.toContain("TOPSECRET");
    expect(await auditRows(t.b.id)).toEqual([]);
  });

  it("audit records the effective actor kind (agent downgrade) and name", async () => {
    await t.op("createMemory", { title: "x", actor: { kind: "agent", name: "memory-health" } });
    await t.op("createMemory", { title: "y", actor: { kind: "user", name: "spoof" } });
    const rows = await auditRows(t.a.id);
    expect(rows.at(-2)).toMatchObject({ actor_kind: "agent", client: "memory-health", ok: true });
    expect(rows.at(-1)).toMatchObject({ actor_kind: "user", client: "User A", ok: true });
  });
});
