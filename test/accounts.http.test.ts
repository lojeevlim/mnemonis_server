import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe as baseDescribe, describe as plainDescribe, expect, it, vi } from "vitest";
import { createAccountService, lockSecondsFor } from "../src/auth/accounts.js";
import { emailHash, isKnownIp, recordFailure, rememberIp, SOFT, softKey, STRICT, strictKey, THROTTLE_LOCK_CLASS } from "../src/auth/throttle.js";
import { PgStore } from "../src/store/pgStore.js";
import { createPasswordHasher, PasswordBusyError } from "../src/auth/password.js";
import { SESSION_RE } from "../src/auth/sessions.js";
import { createFailureLimiter } from "../src/http/auth.js";
import { ipBucket } from "../src/http/ip.js";
import { createPool } from "../src/db/pool.js";
import { fastHasher, FAST_SCRYPT, startTestServer, TEST_DB_URL, usersScopedToTag, type TestServer } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

const servers: TestServer[] = [];
const extraPools: pg.Pool[] = [];
const start = async (o: Parameters<typeof startTestServer>[0] = {}) => {
  const s = await startTestServer(o);
  servers.push(s);
  return s;
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(extraPools.splice(0).map((p) => p.end()));
});

const json = { "Content-Type": "application/json" };
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${s.url}${path}`, { method: "POST", headers: { ...json, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const register = (s: TestServer, name: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(s, "/api/auth/register", { email: s.email(name), password: s.password(name), ...extra }, headers);
const login = (s: TestServer, email: string, password: string, headers: Record<string, string> = {}) => post(s, "/api/auth/login", { email, password }, headers);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (s: TestServer, path: string, token: string) => fetch(`${s.url}${path}`, { headers: bearer(token) });

type AuthBody = { token: string; expiresAt: string; user: { id: string; email: string; displayName: string } };

/** Everything a client could use to tell two refusals apart. */
async function shape(r: Response) {
  const headers = [...r.headers.entries()].filter(([k]) => k !== "date").sort(([a], [b]) => a.localeCompare(b));
  return { status: r.status, body: await r.text(), headers };
}

const INVALID = { error: { code: "invalid_credentials", message: "Invalid email or password" } };

describe("register", () => {
  it("creates the user and workspace and returns a session: 201 {token,expiresAt,user}, no-store", async () => {
    const s = await start();
    const r = await register(s, "new1", { displayName: "  New One  " });
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = (await r.json()) as AuthBody;
    expect(Object.keys(b).sort()).toEqual(["expiresAt", "token", "user"]);
    expect(b.token).toMatch(SESSION_RE);
    expect(b.user).toEqual({ id: expect.any(String), email: s.email("new1"), displayName: "New One" });
    expect(Date.parse(b.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // the session works immediately and the workspace exists (rev 0)
    const st = await get(s, "/api/state", b.token);
    expect(st.status).toBe(200);
    expect(((await st.json()) as { rev: number }).rev).toBe(0);
    const me = (await (await get(s, "/api/auth/me", b.token)).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ id: b.user.id, email: s.email("new1"), displayName: "New One" });
  });

  it("stores only a scrypt hash: never the password or the session token", async () => {
    const s = await start();
    const b = (await (await register(s, "hash")).json()) as AuthBody;
    const row = (await s.pool.query("SELECT u::text AS dump, password_hash, password_updated_at FROM users u WHERE id = $1", [b.user.id])).rows[0];
    expect(row.password_hash).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(row.password_updated_at).not.toBeNull();
    expect(row.dump).not.toContain(s.password("hash"));
    const sess = (await s.pool.query("SELECT t::text AS dump FROM sessions t WHERE user_id = $1", [b.user.id])).rows[0].dump as string;
    expect(sess).not.toContain(b.token);
  });

  it("normalizes the email (case, whitespace) and defaults the display name to the local part", async () => {
    const s = await start();
    const r = await post(s, "/api/auth/register", { email: `  ${s.email("MiXed").toUpperCase()} `, password: s.password("mixed") });
    expect(r.status).toBe(201);
    const b = (await r.json()) as AuthBody;
    expect(b.user.email).toBe(s.email("mixed"));
    expect(b.user.displayName).toBe(`mixed-${s.tag}`);
  });

  it("an existing email (any case) is 409 email_taken and creates nothing", async () => {
    const s = await start();
    expect((await register(s, "dup")).status).toBe(201);
    const again = await post(s, "/api/auth/register", { email: s.email("dup").toUpperCase(), password: s.password("other-secret") });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: "email_taken", message: "That email is already registered" } });
    expect((await s.pool.query("SELECT 1 FROM users WHERE lower(email) = $1", [s.email("dup")])).rowCount).toBe(1);
  });

  it("concurrent registrations of one email yield exactly one account", async () => {
    const s = await start();
    const rs = await Promise.all(Array.from({ length: 6 }, () => register(s, "race")));
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
    expect(rs.filter((r) => r.status === 409).length).toBe(5);
    expect((await s.pool.query("SELECT 1 FROM users WHERE lower(email) = $1", [s.email("race")])).rowCount).toBe(1);
    expect((await s.pool.query("SELECT 1 FROM workspaces w JOIN users u ON u.id = w.user_id WHERE lower(u.email) = $1", [s.email("race")])).rowCount).toBe(1);
  });

  it("email normalisation is NFKC + trim + lowercase, applied alike by register, login and the allowlist", async () => {
    const s = await start({ account: { allowedEmails: ["@example.test"] } });
    const name = `norm${s.tag}`;
    const wide = `  ${[...`${name}@Example.TEST`].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("")} `; // fullwidth letters
    const pw = `Pw-${s.tag}-norm-zebra-lamp`;
    const r = await post(s, "/api/auth/register", { email: wide, password: pw });
    try {
      expect(r.status).toBe(201); // the @example.test allowlist entry matched the NORMALISED address
      const b = (await r.json()) as AuthBody;
      expect(b.user.email).toBe(`${name}@example.test`);
      expect((await login(s, `${name.toUpperCase()}@EXAMPLE.TEST`, pw)).status).toBe(200);
      expect((await login(s, wide, pw)).status).toBe(200);
      expect((await post(s, "/api/auth/register", { email: `${name}@example.test`, password: pw })).status).toBe(409);
    } finally {
      await s.pool.query("DELETE FROM users WHERE email = $1", [`${name}@example.test`]);
    }
  });

  it("requires a dotted domain: local@host (no dot) and degenerate domains are refused", async () => {
    const s = await start();
    for (const email of ["a@b", `user${s.tag}@localhost`, `user${s.tag}@.com`, `user${s.tag}@example.`, `user${s.tag}@exa..mple`, `u\u202e${s.tag}@example.test`]) {
      expect((await post(s, "/api/auth/register", { email, password: s.password("dot") })).status, email).toBe(400);
    }
  });

  it("validates input: 400 invalid_input with a helpful message and no account", async () => {
    const s = await start();
    const bad: [string, unknown][] = [
      ["short password", { email: s.email("v1"), password: "short-pw-1" }],
      ["common password", { email: s.email("v2"), password: "password1234" }],
      ["password is the email name", { email: s.email("v3"), password: `v3-${s.tag}` }],
      ["over 128 bytes", { email: s.email("v4"), password: "é".repeat(65) }],
      ["bad email", { email: "not-an-email", password: s.password("v5") }],
      ["email too long", { email: `${"a".repeat(250)}@x.test`, password: s.password("v6") }],
      ["email with control char", { email: `a\u0007b-${s.tag}@${s.tag}.example.test`, password: s.password("v7") }],
      ["unknown field", { email: s.email("v8"), password: s.password("v8"), isAdmin: true }],
      ["wrong types", { email: 5, password: [] }],
      ["array body", []],
      ["missing password", { email: s.email("v9") }],
    ];
    for (const [name, body] of bad) {
      const r = await post(s, "/api/auth/register", body);
      expect(r.status, name).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code, name).toBe("invalid_input");
    }
    expect((await post(s, "/api/auth/register", "{nope")).status).toBe(400);
    expect((await s.pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE $1", [`%@${s.tag}.example.test`])).rows[0].n).toBe(2); // only A and B
    const weak = (await (await post(s, "/api/auth/register", bad[0]![1])).json()) as { error: { message: string } };
    expect(weak.error.message).toMatch(/at least 12/);
  });

  it("a body over 2 KB is 413 on every public endpoint", async () => {
    const s = await start();
    const big = JSON.stringify({ email: s.email("big"), password: s.password("big"), displayName: "x".repeat(3000) });
    expect((await post(s, "/api/auth/register", big)).status).toBe(413);
    expect((await post(s, "/api/auth/login", big)).status).toBe(413);
  });

  it("registration closed: 403 registration_closed, config says so, login still works", async () => {
    const s = await start({ account: { allowRegistration: false } });
    const r = await register(s, "closed");
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: { code: "registration_closed", message: "Registration is closed" } });
    expect(await (await fetch(`${s.url}/api/auth/config`)).json()).toEqual({ registrationOpen: false, mcpUrl: null });
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
  });

  it("allowlist (exact and @domain) admits only listed emails with the same refusal for the rest", async () => {
    const dom = `allow-${randomUUID().slice(0, 8)}.example.test`;
    const s = await start({ account: { allowedEmails: [`@${dom}`, `exact-${randomUUID().slice(0, 6)}@else.example.test`] } });
    const ok = await post(s, "/api/auth/register", { email: `member@${dom}`, password: s.password("member") });
    expect(ok.status).toBe(201);
    const closed = await register(s, "stranger");
    expect(closed.status).toBe(403);
    expect(((await closed.json()) as { error: { code: string } }).error.code).toBe("registration_closed");
    await s.pool.query("DELETE FROM users WHERE email = $1", [`member@${dom}`]); // outside the tag's own email suffix
  });

  it("MAX_USERS: refused at the cap, and concurrent registrations cannot exceed it", async () => {
    const tag = `mu${randomUUID().slice(0, 6)}`;
    const real = createPool({ connectionString: TEST_DB_URL, max: 8 });
    extraPools.push(real);
    // A and B already exist (count 2); room for exactly one more
    const s = await start({ tag, httpPool: usersScopedToTag(real, tag), account: { maxUsers: 3 } });
    expect(await (await fetch(`${s.url}/api/auth/config`)).json()).toEqual({ registrationOpen: true, mcpUrl: null });
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => register(s, `cap${i}`)));
    expect(rs.filter((r) => r.status === 201).length).toBe(1);
    expect(rs.filter((r) => r.status === 403).length).toBe(4);
    expect((await s.pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE $1", [`%@${tag}.example.test`])).rows[0].n).toBe(3);
    expect(await (await fetch(`${s.url}/api/auth/config`)).json()).toEqual({ registrationOpen: false, mcpUrl: null });
    const over = await register(s, "overflow");
    expect(over.status).toBe(403);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("registration_closed");
  });

  it("GET /api/auth/config exposes only {registrationOpen, mcpUrl} and needs no credentials", async () => {
    const s = await start();
    const r = await fetch(`${s.url}/api/auth/config`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"registrationOpen":true,"mcpUrl":null}');
  });

  it("GET /api/health is exactly {ok:true}", async () => {
    const s = await start();
    const r = await fetch(`${s.url}/api/health`);
    expect(await r.text()).toBe('{"ok":true}');
  });
});

describe("login", () => {
  it("returns a fresh session with the same body shape as register", async () => {
    const s = await start();
    const r = await login(s, s.a.email, s.a.password);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = (await r.json()) as AuthBody;
    expect(b.token).toMatch(SESSION_RE);
    expect(b.token).not.toBe(s.a.session);
    expect(b.user).toEqual({ id: s.a.id, email: s.a.email, displayName: "User A" });
    expect((await get(s, "/api/state", b.token)).status).toBe(200);
    expect((await s.a.api("/api/state")).status).toBe(200); // the other session is unaffected
    expect((await login(s, s.a.email.toUpperCase(), s.a.password)).status).toBe(200); // email is case-insensitive
  });

  it("wrong password, unknown email, malformed email, disabled user and passwordless user are byte-identical 401s", async () => {
    const s = await start();
    await s.pool.query("INSERT INTO users (email, display_name) VALUES ($1, 'nopw')", [s.email("nopw")]);
    await s.pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [s.b.id]);
    const wrong = await shape(await login(s, s.a.email, "definitely-not-the-password"));
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body)).toEqual(INVALID);
    expect(Object.fromEntries(wrong.headers)["www-authenticate"]).toBeUndefined();
    const cases: [string, Response][] = [
      ["unknown email", await login(s, s.email("ghost"), s.a.password)],
      ["malformed email", await login(s, `nonsense-${s.tag}`, s.a.password)],
      ["disabled user, right password", await login(s, s.b.email, s.b.password)],
      ["passwordless user", await login(s, s.email("nopw"), "anything-at-all-1234")],
      ["oversized password", await login(s, s.a.email, "x".repeat(900))],
      ["empty password", await login(s, s.a.email, "")],
    ];
    for (const [name, r] of cases) expect({ name, ...(await shape(r)) }, name).toEqual({ name, ...wrong });
  });

  it("login for a malformed body is 400 (no credential check), and unknown fields are refused", async () => {
    const s = await start();
    expect((await post(s, "/api/auth/login", "{nope")).status).toBe(400);
    expect((await post(s, "/api/auth/login", { email: s.a.email })).status).toBe(400);
    expect((await post(s, "/api/auth/login", { email: s.a.email, password: s.a.password, remember: true })).status).toBe(400);
  });

  it("upgrades a weaker stored hash to the current parameters on successful login", async () => {
    const strong = createPasswordHasher({ params: { N: 2 ** 11, r: 8, p: 1 } });
    const s = await start({ accountOptions: { hasher: strong } });
    expect((await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash).toMatch(/^scrypt\$1024\$/);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
    expect((await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash).toMatch(/^scrypt\$2048\$/);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200); // still works after the upgrade
    expect((await login(s, s.a.email, "wrong-wrong-wrong-1")).status).toBe(401);
  });

  it("a busy hasher during the rehash never turns a successful login into a 503, and the old hash stays", async () => {
    const strong = createPasswordHasher({ params: { N: 2 ** 11, r: 8, p: 1 } });
    const flaky = { ...strong, hash: async () => { throw new PasswordBusyError(); } };
    const s = await start({ accountOptions: { hasher: flaky } });
    const before = (await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash;
    const r = await login(s, s.a.email, s.a.password);
    expect(r.status).toBe(200);
    expect((await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash).toBe(before);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200); // and it keeps working (the next login retries)
  });

  it("the rehash is guarded by the old hash: a password changed meanwhile is never overwritten with the previous password", async () => {
    const strong = createPasswordHasher({ params: { N: 2 ** 11, r: 8, p: 1 } });
    const sentinel = `scrypt$1024$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64, 7).toString("base64")}`;
    const ref: { pool?: pg.Pool; id?: string } = {};
    const racing = {
      ...strong,
      hash: async (pw: string) => {
        const h = await strong.hash(pw);
        await ref.pool!.query("UPDATE users SET password_hash = $1 WHERE id = $2", [sentinel, ref.id]); // a concurrent change lands first (this server's user A only)
        return h;
      },
    };
    const s = await start({ accountOptions: { hasher: racing } });
    ref.pool = s.pool;
    ref.id = s.a.id;
    // The password changed after it was verified: no session is minted for the old password (401), and the new hash is kept.
    expect((await login(s, s.a.email, s.a.password)).status).toBe(401);
    expect((await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash).toBe(sentinel);
  });

  it("warms the dummy hash when the service is constructed", async () => {
    const warm = vi.fn(async () => undefined);
    const s = await start({ accountOptions: { hasher: { ...fastHasher(), warm } } });
    expect(warm).toHaveBeenCalledTimes(1);
    expect(s.url).toContain("http");
  });

  it("a user created before accounts existed gets an empty workspace on first login (self-heal)", async () => {
    const s = await start();
    const hash = (await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash as string;
    const row = await s.pool.query<{ id: string }>("INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'Legacy', $2) RETURNING id", [s.email("legacy"), hash]);
    const b = (await (await login(s, s.email("legacy"), s.a.password)).json()) as AuthBody;
    expect(b.user.id).toBe(row.rows[0]!.id);
    expect(((await (await get(s, "/api/state", b.token)).json()) as { rev: number }).rev).toBe(0);
  });

  it("scrypt overload answers 503 busy with Retry-After, not a hang or a 401", async () => {
    const hasher = createPasswordHasher({ params: FAST_SCRYPT, maxConcurrent: 1, maxQueue: 0 });
    const s = await start({ accountOptions: { hasher } });
    // Distinct accounts: a burst of logins for ONE email+IP is capped by the attempt counter (see the burst test), not by the hasher.
    const users = await Promise.all(Array.from({ length: 12 }, (_, i) => s.makeUser(`busy${i}`)));
    const rs = await Promise.all(users.map((u) => login(s, u.email, u.password)));
    const statuses = rs.map((r) => r.status);
    expect(statuses).toContain(503);
    expect(statuses).toContain(200);
    const busy = rs.find((r) => r.status === 503)!;
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("busy");
  });
});

describe("logout, me, password change, delete account", () => {
  it("logout revokes only the calling session (204) and a second logout is 401", async () => {
    const s = await start();
    const second = (await (await login(s, s.a.email, s.a.password)).json()) as AuthBody;
    const out = await post(s, "/api/auth/logout", "", bearer(second.token));
    expect(out.status).toBe(204);
    expect(await out.text()).toBe("");
    expect((await get(s, "/api/state", second.token)).status).toBe(401);
    expect((await post(s, "/api/auth/logout", "", bearer(second.token))).status).toBe(401);
    expect((await s.a.api("/api/state")).status).toBe(200);
  });

  it("me needs a session and returns the profile and session expiry", async () => {
    const s = await start();
    expect((await fetch(`${s.url}/api/auth/me`)).status).toBe(401);
    const me = (await (await s.a.api("/api/auth/me")).json()) as { id: string; email: string; displayName: string; session: { expiresAt: string } };
    expect(me).toMatchObject({ id: s.a.id, email: s.a.email, displayName: "User A" });
    expect(Date.parse(me.session.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("changing the password revokes all OTHER sessions, keeps the current one, and swaps the credentials", async () => {
    const s = await start();
    const other = (await (await login(s, s.a.email, s.a.password)).json()) as AuthBody;
    const next = `${s.password("a")}-new-9`;
    const r = await post(s, "/api/auth/password", { currentPassword: s.a.password, newPassword: next }, s.a.headers());
    expect(r.status).toBe(204);
    expect((await s.a.api("/api/state")).status).toBe(200); // current session survives
    expect((await get(s, "/api/state", other.token)).status).toBe(401); // others are revoked
    expect((await login(s, s.a.email, s.a.password)).status).toBe(401);
    expect((await login(s, s.a.email, next)).status).toBe(200);
    expect((await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash).not.toContain(next);
  });

  it("password change is atomic: if revoking the other sessions fails, the old password stays and no session is left valid under a changed password", async () => {
    const s = await start();
    const other = (await (await login(s, s.a.email, s.a.password)).json()) as AuthBody;
    const before = (await s.pool.query("SELECT password_hash, password_updated_at FROM users WHERE id = $1", [s.a.id])).rows[0];
    // A pool whose transaction clients fail on the session-revoking statement.
    const failing = {
      query: s.pool.query.bind(s.pool),
      connect: async () => {
        const c = await s.pool.connect();
        const origQuery = c.query;
        const origRelease = c.release.bind(c);
        const q = c.query.bind(c) as (...a: unknown[]) => unknown;
        c.release = (err?: boolean | Error) => {
          (c as unknown as { query: unknown }).query = origQuery; // the pooled connection must not stay patched
          origRelease(err);
        };
        (c as unknown as { query: unknown }).query = (...a: unknown[]) => {
          if (typeof a[0] === "string" && a[0].includes("UPDATE sessions SET revoked_at")) return Promise.reject(new Error("boom"));
          return q(...a);
        };
        return c;
      },
    } as unknown as pg.Pool;
    const svc = createAccountService(failing, new PgStore(s.pool), { maxMcpTokens: 20, allowRegistration: true, allowedEmails: [], maxUsers: 100_000, sessionIdleDays: 7, sessionMaxDays: 30 }, { hasher: fastHasher() });
    const next = `${s.password("a")}-new-9`;
    await expect(svc.changePassword(s.a.id, "00000000-0000-0000-0000-000000000000", s.a.password, next)).rejects.toThrow("boom");
    expect((await s.pool.query("SELECT password_hash, password_updated_at FROM users WHERE id = $1", [s.a.id])).rows[0]).toEqual(before); // rolled back
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200); // the old password still works
    expect((await login(s, s.a.email, next)).status).toBe(401);
    expect((await get(s, "/api/state", other.token)).status).toBe(200); // sessions untouched together with the password
  });

  it("password change refuses a wrong current password (403, nothing changes), a weak or unchanged new one (400), and unknown fields", async () => {
    const s = await start();
    const other = (await (await login(s, s.a.email, s.a.password)).json()) as AuthBody;
    const change = (body: unknown) => post(s, "/api/auth/password", body, s.a.headers());
    const wrong = await change({ currentPassword: "not-the-current-one", newPassword: `${s.a.password}-new-9` });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("invalid_password");
    expect((await change({ currentPassword: s.a.password, newPassword: "short" })).status).toBe(400);
    expect((await change({ currentPassword: s.a.password, newPassword: "password1234" })).status).toBe(400);
    expect((await change({ currentPassword: s.a.password, newPassword: s.a.password })).status).toBe(400);
    expect((await change({ currentPassword: s.a.password, newPassword: `${s.a.password}-x9`, extra: 1 })).status).toBe(400);
    expect((await change("{nope")).status).toBe(400);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
    expect((await get(s, "/api/state", other.token)).status).toBe(200); // not revoked by the failed attempts
    expect((await post(s, "/api/auth/password", { currentPassword: s.a.password, newPassword: `${s.a.password}-x9` })).status).toBe(401); // needs a session
  });

  it("repeated wrong current passwords are backed off (429 with Retry-After), even with the right one afterwards", async () => {
    const s = await start();
    const change = (cur: string) => post(s, "/api/auth/password", { currentPassword: cur, newPassword: `${s.a.password}-n9` }, s.a.headers());
    for (let i = 0; i < 5; i++) expect((await change("wrong-wrong-wrong-1")).status).toBe(403);
    const locked = await change(s.a.password);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("the re-authentication backoff is persisted: a restarted service still refuses, for change-password and delete-account alike", async () => {
    const s = await start();
    const change = (cur: string) => post(s, "/api/auth/password", { currentPassword: cur, newPassword: `${s.a.password}-n9` }, s.a.headers());
    for (let i = 0; i < 5; i++) expect((await change("wrong-wrong-wrong-1")).status).toBe(403);
    expect((await s.pool.query("SELECT scope, failures FROM login_throttle WHERE subject = $1", [s.a.id])).rows).toEqual([{ scope: "reauth", failures: 5 }]);
    const restarted = createAccountService(s.pool, new PgStore(s.pool), { maxMcpTokens: 20, allowRegistration: true, allowedEmails: [], maxUsers: 100_000, sessionIdleDays: 7, sessionMaxDays: 30 }, { hasher: fastHasher() });
    await expect(restarted.deleteAccount(s.a.id, s.a.password)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(restarted.changePassword(s.a.id, "00000000-0000-0000-0000-000000000000", s.a.password, `${s.a.password}-n9`)).rejects.toMatchObject({ code: "rate_limited" });
    await s.pool.query("UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE subject = $1", [s.a.id]);
    expect((await change(s.a.password)).status).toBe(204); // and a success clears the counter
    expect((await s.pool.query("SELECT 1 FROM login_throttle WHERE subject = $1", [s.a.id])).rowCount).toBe(0);
  });

  it("an oversize current password is simply incorrect (403), not a 400 and not hashed", async () => {
    const s = await start();
    const r = await post(s, "/api/auth/password", { currentPassword: "x".repeat(1500), newPassword: `${s.a.password}-n9` }, s.a.headers());
    expect(r.status).toBe(403);
  });

  it("DELETE /api/auth/me re-checks the password, cascades everything and spares other users", async () => {
    const s = await start();
    const victim = await s.makeUser("victim");
    const token = (await victim.mcpToken()).token;
    await victim.op("createMemory", { title: "bye" });
    const del = (password: string) => fetch(`${s.url}/api/auth/me`, { method: "DELETE", headers: victim.headers(json), body: JSON.stringify({ password }) });
    const wrong = await del("not-the-password");
    expect(wrong.status).toBe(403);
    expect((await victim.api("/api/state")).status).toBe(200);
    expect((await fetch(`${s.url}/api/auth/me`, { method: "DELETE", headers: victim.headers(json), body: "{}" })).status).toBe(400);
    const ok = await del(victim.password);
    expect(ok.status).toBe(204);
    expect((await victim.api("/api/state")).status).toBe(401);
    const mcp = await fetch(`${s.url}/api/agent/ping`, { headers: { "X-Mnemonis-Contract": "1", Authorization: `Bearer ${token}` } });
    expect(mcp.status).toBe(401);
    expect((await login(s, victim.email, victim.password)).status).toBe(401);
    for (const t of ["users WHERE id", "workspaces WHERE user_id", "sessions WHERE user_id", "api_tokens WHERE user_id"]) {
      expect((await s.pool.query(`SELECT 1 FROM ${t} = $1`, [victim.id])).rowCount, t).toBe(0);
    }
    expect((await s.a.api("/api/state")).status).toBe(200);
    await s.audit.flush();
    const rows = (await s.pool.query("SELECT user_id, client, action, ok FROM audit_log WHERE action = 'auth:delete' AND client = 'account-deleted' AND ok")).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === null)).toBe(true);
    await s.pool.query("DELETE FROM audit_log WHERE user_id IS NULL AND client = 'account-deleted'");
  });

  it("a disabled user's session stops working immediately", async () => {
    const s = await start();
    expect((await s.a.api("/api/auth/me")).status).toBe(200);
    await s.pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [s.a.id]);
    expect((await s.a.api("/api/auth/me")).status).toBe(401);
    await s.pool.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [s.a.id]);
    expect((await s.a.api("/api/auth/me")).status).toBe(200);
  });
});

describe("rate limits and lockout", () => {
  it("per-client login limiter: the 11th attempt in a minute is 429 with Retry-After, successes count too", async () => {
    const s = await start({ authLimiters: { register: createFailureLimiter({ max: 10 }), login: createFailureLimiter({ max: 3 }), config: createFailureLimiter({ max: 2 }) } });
    for (let i = 0; i < 3; i++) expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
    const blocked = await login(s, s.a.email, s.a.password);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    // other endpoints keep their own buckets
    expect((await fetch(`${s.url}/api/auth/config`)).status).toBe(200);
    expect((await fetch(`${s.url}/api/auth/config`)).status).toBe(200);
    expect((await fetch(`${s.url}/api/auth/config`)).status).toBe(429);
    expect((await s.a.api("/api/state")).status).toBe(200);
    expect((await register(s, "lim")).status).toBe(201);
  });

  it("per-client register limiter", async () => {
    const s = await start({ authLimiters: { register: createFailureLimiter({ max: 2 }), login: createFailureLimiter({ max: 99 }), config: createFailureLimiter({ max: 99 }) } });
    expect((await register(s, "r1")).status).toBe(201);
    expect((await register(s, "r2")).status).toBe(201);
    const r3 = await register(s, "r3");
    expect(r3.status).toBe(429);
    expect(r3.headers.get("retry-after")).toBe("60");
    expect((await s.pool.query("SELECT 1 FROM users WHERE lower(email) = $1", [s.email("r3")])).rowCount).toBe(0);
  });

  it("5 wrong passwords from one client lock that (email, IP) pair: the 6th attempt is 429 even with the right password; other users and existing sessions are unaffected", async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) expect((await login(s, s.a.email, `wrong-password-${i}-xx`)).status).toBe(401);
    const locked = await login(s, s.a.email, s.a.password);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(locked.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    const rows = (await s.pool.query("SELECT scope, failures, locked_until FROM login_throttle WHERE subject = $1 ORDER BY scope", [emailHash(s.a.email)])).rows;
    expect(rows.map((r) => [r.scope, r.failures])).toEqual([["email", 5], ["email_ip", 5]]);
    expect(rows[1].locked_until.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].locked_until).toBeNull(); // the soft email lock needs 10 failures
    expect((await s.a.api("/api/state")).status).toBe(200); // existing sessions are not affected by the login lock
    expect((await login(s, s.b.email, s.b.password)).status).toBe(200);
  });

  it("a concurrent burst of wrong guesses for one (email, IP) is capped at the lock threshold (the attempt is counted before the verify)", async () => {
    const s = await start();
    const verify = vi.fn(fastHasher().verify);
    const hasher = { ...fastHasher(), verify };
    const svc = createAccountService(s.pool, new PgStore(s.pool), { maxMcpTokens: 20, allowRegistration: true, allowedEmails: [], maxUsers: 100_000, sessionIdleDays: 7, sessionMaxDays: 30 }, { hasher });
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => svc.login({ email: s.a.email, password: `wrong-guess-${i}-xx` }, { ip: "127.0.0.1" })));
    const codes = results.map((r) => (r.status === "rejected" ? (r.reason as { code?: string }).code : "ok"));
    expect(codes.filter((c) => c === "invalid_credentials")).toHaveLength(STRICT.after); // exactly the threshold got to guess
    expect(codes.filter((c) => c === "rate_limited")).toHaveLength(30 - STRICT.after);
    expect(verify).toHaveBeenCalledTimes(STRICT.after); // and only those paid for a password check
    const strictRow = (await s.pool.query("SELECT failures, locked_until FROM login_throttle WHERE key = $1", [strictKey(emailHash(s.a.email), "127.0.0.1").key])).rows[0];
    expect(strictRow.failures).toBe(STRICT.after); // refused attempts are not counted
    expect(strictRow.locked_until.getTime()).toBeGreaterThan(Date.now());
    await expect(svc.login({ email: s.a.email, password: s.a.password }, { ip: "127.0.0.1" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("a successful login clears the counters that the attempt reserved", async () => {
    const s = await start();
    for (let i = 0; i < 3; i++) expect((await login(s, s.a.email, `wrong-password-${i}-xx`)).status).toBe(401);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
    expect((await s.pool.query("SELECT 1 FROM login_throttle WHERE subject = $1", [emailHash(s.a.email)])).rowCount).toBe(0);
  });

  it("the strict lock doubles from 60 s up to a 900 s cap and a success clears it", async () => {
    const s = await start();
    const k = strictKey(emailHash(s.a.email), "127.0.0.1");
    for (let i = 0; i < 9; i++) await recordFailure(s.pool, k, STRICT);
    const wait = async () => Number((await s.pool.query("SELECT EXTRACT(EPOCH FROM (locked_until - now())) AS w FROM login_throttle WHERE key = $1", [k.key])).rows[0].w);
    expect(await wait()).toBeGreaterThan(800); // 9th failure: 60 * 2^4 = 960 -> capped at 900
    expect(await wait()).toBeLessThanOrEqual(900);
    await s.pool.query("UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE key = $1", [k.key]);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
    expect((await s.pool.query("SELECT 1 FROM login_throttle WHERE subject = $1", [emailHash(s.a.email)])).rowCount).toBe(0);
  });

  it("an unknown email is throttled by exactly the same schedule (no existence signal)", async () => {
    const s = await start();
    const seq = async (email: string) => {
      const out: number[] = [];
      for (let i = 0; i < 7; i++) out.push((await login(s, email, `wrong-password-${i}-xx`)).status);
      return out;
    };
    const known = await seq(s.a.email);
    const unknown = await seq(s.email("nobody"));
    expect(known).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(unknown).toEqual(known);
    // and the stored structure is the same rows with hashed keys only: no email or IP in the clear
    const dump = JSON.stringify((await s.pool.query("SELECT * FROM login_throttle WHERE subject = ANY($1)", [[emailHash(s.a.email), emailHash(s.email("nobody"))]])).rows);
    expect(dump).not.toContain(s.tag);
    expect(dump).not.toContain("127.0.0.1");
  });

  describe("soft email lock (M1: a known email cannot be locked out forever)", () => {
    const spread = async (s: TestServer, email: string, n: number) => {
      // n failures spread over several client addresses so no single (email, IP) pair reaches the strict limit
      for (let i = 0; i < n; i++) await login(s, email, `wrong-password-${i}-xx`, { "X-Forwarded-For": `203.0.113.${1 + (i % 5)}` });
    };
    const from = (ip: string) => ({ "X-Forwarded-For": ip });

    it("10 failures across clients soft-lock the email for at most 60 s; a correct password from a NEW client is refused, from a known-good client it is accepted", async () => {
      const s = await start({ trustProxy: true });
      expect((await login(s, s.a.email, s.a.password, from("198.51.100.7"))).status).toBe(200); // 198.51.100.7 is now known-good for A
      await spread(s, s.a.email, 10);
      const refused = await login(s, s.a.email, s.a.password, from("198.51.100.99"));
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
      // a wrong password from the known client is still a plain 401, and the soft lock keeps protecting other clients
      expect((await login(s, s.a.email, "wrong-password-known-1", from("198.51.100.7"))).status).toBe(401);
      expect((await login(s, s.a.email, s.a.password, from("198.51.100.99"))).status).toBe(429);
      expect((await login(s, s.a.email, s.a.password, from("198.51.100.7"))).status).toBe(200); // known-good bypass
      // the owner's success proves the password and clears the soft lock for everyone
      expect((await login(s, s.a.email, s.a.password, from("198.51.100.99"))).status).toBe(200);
      // the lock also simply expires on its own
      await spread(s, s.a.email, 10);
      expect((await login(s, s.a.email, s.a.password, from("198.51.100.150"))).status).toBe(429);
      await s.pool.query("UPDATE login_throttle SET locked_until = now() - interval '1 second' WHERE key = $1", [softKey(emailHash(s.a.email)).key]);
      expect((await login(s, s.a.email, s.a.password, from("198.51.100.150"))).status).toBe(200);
    });

    it("the soft lock never exceeds 60 s however many failures arrive, and a trickle (1 per 15 min) never locks at all", async () => {
      const s = await start();
      const k = softKey(emailHash(s.a.email));
      for (let i = 0; i < 40; i++) await recordFailure(s.pool, k, SOFT);
      const w = Number((await s.pool.query("SELECT EXTRACT(EPOCH FROM (locked_until - now())) AS w FROM login_throttle WHERE key = $1", [k.key])).rows[0].w);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(60);
      // the counter decays after 15 minutes of quiet: one bad login per 15 min only ever counts as 1
      await s.pool.query("UPDATE login_throttle SET failures = 9, locked_until = NULL, updated_at = now() - interval '16 minutes' WHERE key = $1", [k.key]);
      await recordFailure(s.pool, k, SOFT);
      const row = (await s.pool.query("SELECT failures, locked_until FROM login_throttle WHERE key = $1", [k.key])).rows[0];
      expect(row).toEqual({ failures: 1, locked_until: null });
    });

    it("an unknown email is soft-locked identically (indistinguishable from a known one)", async () => {
      const s = await start({ trustProxy: true });
      await spread(s, s.email("ghost"), 10);
      await spread(s, s.a.email, 10);
      const probe = async (email: string) => {
        const r = await login(s, email, "another-wrong-password-9", from("198.51.100.200"));
        return { status: r.status, retry: Number(r.headers.get("retry-after")) > 0, body: await r.text() };
      };
      expect(await probe(s.email("ghost"))).toEqual(await probe(s.a.email));
      expect((await probe(s.a.email)).status).toBe(429);
    });

    it("throttle state lives in the database: a freshly constructed service (a restart) sees the same locks, for known and unknown emails", async () => {
      const s = await start();
      for (let i = 0; i < 5; i++) {
        await login(s, s.a.email, `wrong-password-${i}-xx`);
        await login(s, s.email("ghost2"), `wrong-password-${i}-xx`);
      }
      const store = new PgStore(s.pool);
      const restarted = createAccountService(s.pool, store, { maxMcpTokens: 20, allowRegistration: true, allowedEmails: [], maxUsers: 100_000, sessionIdleDays: 7, sessionMaxDays: 30 }, { hasher: fastHasher() });
      for (const [email, pw] of [[s.a.email, s.a.password], [s.email("ghost2"), "whatever-password-12"]] as const) {
        await expect(restarted.login({ email, password: pw }, { ip: "127.0.0.1" })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
      }
    });
  });

  describe("known-good IPs", () => {
    it("are stored hashed (per-user salt), bounded to 20 per user, honoured for 30 days and cleared by a password change", async () => {
      const s = await start();
      const count = async () => Number((await s.pool.query("SELECT count(*) AS n FROM known_login_ips WHERE user_id = $1", [s.a.id])).rows[0].n);
      for (let i = 0; i < 25; i++) await rememberIp(s.pool, s.a.id, `192.0.2.${i + 1}`);
      expect(await count()).toBe(20);
      expect(await isKnownIp(s.pool, s.a.id, "192.0.2.25")).toBe(true);
      expect(await isKnownIp(s.pool, s.a.id, "192.0.2.1")).toBe(false); // the oldest were evicted
      expect(await isKnownIp(s.pool, s.b.id, "192.0.2.25")).toBe(false); // per user
      const stored = (await s.pool.query("SELECT ip_hash FROM known_login_ips WHERE user_id = $1", [s.a.id])).rows as { ip_hash: Buffer }[];
      expect(stored.every((r) => Buffer.isBuffer(r.ip_hash) && r.ip_hash.length === 32)).toBe(true); // sha256 digests only, no address text
      await s.pool.query("UPDATE known_login_ips SET last_success_at = now() - interval '31 days' WHERE user_id = $1", [s.a.id]);
      expect(await isKnownIp(s.pool, s.a.id, "192.0.2.25")).toBe(false);
      await rememberIp(s.pool, s.a.id, "192.0.2.25");
      expect(await isKnownIp(s.pool, s.a.id, "192.0.2.25")).toBe(true);
      const r = await post(s, "/api/auth/password", { currentPassword: s.a.password, newPassword: `${s.a.password}-n9` }, s.a.headers());
      expect(r.status).toBe(204);
      expect(await isKnownIp(s.pool, s.a.id, "192.0.2.25")).toBe(false);
    });
  });

  it("successful logins reset the failure counters", async () => {
    const s = await start();
    for (let i = 0; i < 4; i++) await login(s, s.a.email, `wrong-password-${i}-xx`);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(s, s.a.email, `wrong-password-${i}-xx`)).status).toBe(401);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
  });

  it("oversize passwords (> 1024 chars) get the same uniform 401 as any wrong password; oversize bodies stay 413", async () => {
    const s = await start();
    const wrong = await shape(await login(s, s.a.email, "wrong-password-0-xx"));
    const huge = await shape(await login(s, s.a.email, "x".repeat(1500)));
    expect(huge).toEqual(wrong);
    expect(huge.status).toBe(401);
    const unknown = await shape(await login(s, s.email("nobody"), "x".repeat(1500)));
    expect(unknown).toEqual(wrong);
    expect((await login(s, s.a.email, "x".repeat(3000))).status).toBe(413);
  });

  it("GET /api/auth/config reports MAX_USERS reached exactly like closed registration (no extra information)", async () => {
    const closed = await start({ account: { allowRegistration: false } });
    const capped = await start({ account: { maxUsers: 1 } }); // users A and B of this server already exceed the cap
    const open = await start();
    const bodyOf = async (s: TestServer) => ({ text: await (await fetch(`${s.url}/api/auth/config`)).text() });
    expect(await bodyOf(closed)).toEqual({ text: '{"registrationOpen":false,"mcpUrl":null}' });
    expect(await bodyOf(capped)).toEqual(await bodyOf(closed));
    expect(await bodyOf(open)).toEqual({ text: '{"registrationOpen":true,"mcpUrl":null}' });
    // and the refusal itself is the same registration_closed
    const r1 = await register(capped, "late");
    const r2 = await register(closed, "late");
    expect([r1.status, await r1.text()]).toEqual([r2.status, await r2.text()]);
  });

  it("4 wrong logins followed by the correct password still succeed (the strict lock starts at 5), and the counters are cleared", async () => {
    const s = await start();
    for (let i = 0; i < 4; i++) expect((await login(s, s.a.email, `wrong-password-${i}-xx`)).status).toBe(401);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200);
    expect((await s.pool.query("SELECT 1 FROM login_throttle WHERE subject = $1", [emailHash(s.a.email)])).rowCount).toBe(0);
  });

  it("a busy hasher during login answers 503 with Retry-After and refunds the attempt", async () => {
    const hasher = { ...fastHasher(), verify: async () => { throw new PasswordBusyError(); } };
    const s = await start({ accountOptions: { hasher } });
    const r = await login(s, s.a.email, s.a.password);
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("busy");
    const rows = (await s.pool.query("SELECT scope, failures FROM login_throttle WHERE subject = $1 ORDER BY scope", [emailHash(s.a.email)])).rows;
    expect(rows).toEqual([{ scope: "email", failures: 0 }, { scope: "email_ip", failures: 0 }]);
  });

  it("a busy hasher during the re-authentication (change password) answers 503 with Retry-After and refunds the attempt", async () => {
    const hasher = { ...fastHasher(), verify: async () => { throw new PasswordBusyError(); } };
    const s = await start({ accountOptions: { hasher } });
    const r = await post(s, "/api/auth/password", { currentPassword: s.a.password, newPassword: `${s.a.password}-n9` }, s.a.headers());
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("5");
    expect((await s.pool.query("SELECT scope, failures FROM login_throttle WHERE subject = $1", [s.a.id])).rows).toEqual([{ scope: "reauth", failures: 0 }]);
  });

  it("a throttle lock that cannot be taken within the lock timeout answers 503 with Retry-After (and counts nothing)", async () => {
    const s = await start();
    const holder = await s.pool.connect();
    try {
      await holder.query("BEGIN");
      const strict = strictKey(emailHash(s.a.email), "127.0.0.1");
      await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [THROTTLE_LOCK_CLASS, strict.key]);
      const r = await login(s, s.a.email, s.a.password);
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("5");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect((await s.pool.query("SELECT 1 FROM login_throttle WHERE subject = $1", [emailHash(s.a.email)])).rowCount).toBe(0);
    expect((await login(s, s.a.email, s.a.password)).status).toBe(200); // recovers once the lock is gone
  }, 15_000);

  it("a login whose password is changed between the verify and the session creation mints no session (and the new password works)", async () => {
    const base = fastHasher();
    let hook: (() => Promise<void>) | null = null;
    const racing = {
      ...base,
      verify: async (pw: string, h: string) => {
        const ok = await base.verify(pw, h);
        const f = hook;
        hook = null;
        if (ok && f) await f(); // the password change lands right after the (correct) verify
        return ok;
      },
    };
    const s = await start({ accountOptions: { hasher: racing } });
    const sessions = async () => Number((await s.pool.query("SELECT count(*) AS n FROM sessions WHERE user_id = $1", [s.a.id])).rows[0].n);
    const before = await sessions();
    const next = `${s.a.password}-n9`;
    let changed = 0;
    hook = async () => {
      changed = (await post(s, "/api/auth/password", { currentPassword: s.a.password, newPassword: next }, s.a.headers())).status;
    };
    const r = await login(s, s.a.email, s.a.password);
    expect(changed).toBe(204);
    expect(r.status).toBe(401);
    expect(await sessions()).toBe(before); // nothing was minted for the old password
    expect((await login(s, s.a.email, s.a.password)).status).toBe(401);
    expect((await login(s, s.a.email, next)).status).toBe(200);
  });

  it("changePassword never overwrites a password that changed after the current one was verified (409, the other hash stays)", async () => {
    const base = fastHasher();
    const sentinel = `scrypt$1024$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64, 7).toString("base64")}`;
    const ref: { pool?: pg.Pool; id?: string } = {};
    const racing = {
      ...base,
      hash: async (pw: string) => {
        const h = await base.hash(pw);
        await ref.pool!.query("UPDATE users SET password_hash = $1 WHERE id = $2", [sentinel, ref.id]); // another change lands first
        return h;
      },
    };
    const s = await start({ accountOptions: { hasher: racing } });
    ref.pool = s.pool;
    ref.id = s.a.id;
    const r = await post(s, "/api/auth/password", { currentPassword: s.a.password, newPassword: `${s.a.password}-n9` }, s.a.headers());
    expect(r.status).toBe(409);
    expect((await s.pool.query("SELECT password_hash FROM users WHERE id = $1", [s.a.id])).rows[0].password_hash).toBe(sentinel);
  });
});

describe("token labels", () => {
  it("a label with control, bidi or zero-width characters is a 400 (never silently stripped); a clean label is stored as sent", async () => {
    const s = await start();
    const create = (label: string) => s.a.api("/api/tokens", { method: "POST", headers: json, body: JSON.stringify({ label }) });
    for (const label of ["lap\u0007top", "lap\ntop", "lap\u202etop", "lap\u200btop"]) {
      const r = await create(label);
      expect(r.status, JSON.stringify(label)).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("invalid_input");
    }
    expect((await s.pool.query("SELECT 1 FROM api_tokens WHERE user_id = $1", [s.a.id])).rowCount).toBe(0);
    const ok = await create("  my laptop  ");
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { label: string }).label).toBe("my laptop");
  });
});

describe("audit of account events", () => {
  it("records outcomes with userId and an IP bucket, and never emails, passwords, tokens or the submitted email", async () => {
    const s = await start({ trustProxy: true });
    const ip = `2001:db8:${s.tag.slice(0, 4)}:${s.tag.slice(4, 8)}::1`; // unique per run; recorded as its /64 bucket
    const client = `ip:${ipBucket(ip)}`;
    const xff = { "X-Forwarded-For": ip };
    try {
      const reg = (await (await register(s, "aud", {}, xff)).json()) as AuthBody;
      await login(s, s.email("aud"), "wrong-password-for-audit-1", xff);
      await login(s, s.email("ghost-aud"), "wrong-password-for-audit-2", xff);
      const sess = (await (await login(s, s.email("aud"), s.password("aud"), xff)).json()) as AuthBody;
      await post(s, "/api/auth/password", { currentPassword: s.password("aud"), newPassword: `${s.password("aud")}-new` }, bearer(sess.token));
      await post(s, "/api/auth/logout", "", bearer(sess.token));
      await s.audit.flush();
      const rows = (await s.pool.query("SELECT user_id, via, client, actor_kind, action, ids, ok, code FROM audit_log WHERE user_id = $1 OR client = $2 ORDER BY id", [reg.user.id, client])).rows;
      const summary = rows.map((r) => [r.action, r.ok, r.code ?? null, r.user_id === null ? "no-user" : "user"]);
      expect(summary).toEqual([
        ["auth:register", true, null, "user"],
        ["auth:login", false, "invalid_credentials", "no-user"],
        ["auth:login", false, "invalid_credentials", "no-user"],
        ["auth:login", true, null, "user"],
        ["auth:password", true, null, "user"],
        ["auth:logout", true, null, "user"],
      ]);
      expect(rows[0].user_id).toBe(reg.user.id);
      const dump = JSON.stringify(rows);
      for (const secret of [s.password("aud"), "wrong-password-for-audit", reg.token, sess.token, s.email("aud"), s.email("ghost-aud"), "ghost-aud", `@${s.tag}.example.test`]) {
        expect(dump, secret).not.toContain(secret);
      }
      expect(rows[1].client).toBe(client);
      expect(client).toMatch(/^ip:2001:db8:[0-9a-f]+:[0-9a-f]+::\/64$/);
    } finally {
      await s.pool.query("DELETE FROM audit_log WHERE user_id IS NULL AND client = $1", [client]);
    }
  });

  it("never writes unvalidated X-Forwarded-For text into audit_log.client: an invalid entry falls back to the socket address", async () => {
    const s = await start({ trustProxy: true });
    const hostile = `evil-${s.tag}<script>'--`;
    try {
      await login(s, s.email("nobody-aud"), "wrong-password-for-audit-3", { "X-Forwarded-For": `1.2.3.4, ${hostile}` });
      await login(s, s.email("nobody-aud"), "wrong-password-for-audit-3", { "X-Forwarded-For": "999.1.1.1" });
      await s.audit.flush();
      const rows = (await s.pool.query("SELECT client FROM audit_log WHERE user_id IS NULL AND action = 'auth:login' AND at > now() - interval '1 minute' AND client LIKE 'ip:%'")).rows;
      const clients = new Set(rows.map((r) => r.client as string));
      expect(JSON.stringify([...clients])).not.toContain(s.tag);
      expect(JSON.stringify([...clients])).not.toContain("script");
      expect(clients.has("ip:127.0.0.1")).toBe(true);
    } finally {
      await s.pool.query("DELETE FROM audit_log WHERE user_id IS NULL AND action = 'auth:login' AND client = 'ip:127.0.0.1' AND at > now() - interval '1 minute' AND NOT ok");
    }
  });

  it("token and ops audit rows carry the user id and no secrets", async () => {
    const s = await start();
    const created = (await (await s.a.api("/api/tokens", { method: "POST", headers: json, body: JSON.stringify({ label: "LABEL-SECRET" }) })).json()) as { token: string; id: string };
    await s.a.op("createMemory", { title: "T", content: "CONTENT-SECRET" });
    await s.audit.flush();
    const rows = (await s.pool.query("SELECT * FROM audit_log WHERE user_id = $1", [s.a.id])).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const dump = JSON.stringify(rows);
    for (const secret of [created.token, s.a.session, s.a.password, "LABEL-SECRET", "CONTENT-SECRET", s.a.email]) expect(dump, secret).not.toContain(secret);
  });
});

plainDescribe("login throttle schedules (no database)", () => {
  it("strict: 5 failures lock for 1 minute, then it doubles up to 15 minutes", () => {
    expect([0, 1, 4].map((n) => lockSecondsFor(n))).toEqual([0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 20].map((n) => lockSecondsFor(n))).toEqual([60, 120, 240, 480, 900, 900, 900]);
  });

  it("soft: 10 failures lock for a fixed 60 seconds and never escalate", () => {
    expect([0, 5, 9].map((n) => lockSecondsFor(n, SOFT))).toEqual([0, 0, 0]);
    expect([10, 11, 50, 5000].map((n) => lockSecondsFor(n, SOFT))).toEqual([60, 60, 60, 60]);
  });
});
