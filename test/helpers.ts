import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type pg from "pg";
import { createPgAudit, type PgAudit } from "../src/audit.js";
import { createAccountService, type AccountConfig, type AccountService, type AccountServiceOptions } from "../src/auth/accounts.js";
import { createToken } from "../src/auth/apiTokens.js";
import { emailHash } from "../src/auth/throttle.js";
import { createPasswordHasher, type PasswordHasher } from "../src/auth/password.js";
import { createSession } from "../src/auth/sessions.js";
import { createPool } from "../src/db/pool.js";
import type { FailureLimiter } from "../src/http/auth.js";
import type { AuthLimiters } from "../src/http/authRoutes.js";
import { startHttpServer, type RunningServer } from "../src/http/server.js";
import { createRateLimiter, type RateLimiter } from "../src/service/guards.js";
import { createMemoryServices, type MemoryService, type MemoryServices } from "../src/service/memoryService.js";
import { PgStore } from "../src/store/pgStore.js";
import type { Quotas } from "../src/store/quota.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

/** Cheap scrypt parameters so tests stay fast; the production parameters are covered in password.test.ts. */
export const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 };
export const fastHasher = (): PasswordHasher => createPasswordHasher({ params: FAST_SCRYPT });

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  password: string;
  /** A valid login session token (`ms_...`) for this user (REST). */
  session: string;
  service: MemoryService;
  /** Authorization header with the session token (REST). */
  headers(extra?: Record<string, string>): Record<string, string>;
  api(path: string, init?: RequestInit): Promise<Response>;
  op(name: string, body?: unknown): Promise<Response>;
  /** Mints a fresh MCP token straight in the database (the plaintext is returned once). */
  mcpToken(label?: string): Promise<{ id: string; token: string }>;
  /** Authorization header with an MCP token (/api/agent/*). */
  mcpHeaders(token: string, extra?: Record<string, string>): Record<string, string>;
}

export interface TestServer {
  url: string;
  port: number;
  pool: pg.Pool;
  store: PgStore;
  services: MemoryServices;
  audit: PgAudit;
  accounts: AccountService;
  /** Unique per server; every user/email created by this server (also via HTTP) carries it. */
  tag: string;
  server: RunningServer;
  a: TestUser;
  b: TestUser;
  /** Email of the form `<name>-<tag>@<tag>.example.test`: removed by close(). */
  email(name: string): string;
  /** A password that satisfies the policy. */
  password(name?: string): string;
  /** Creates a user straight in the database (fast hash) and returns it with a fresh session. */
  makeUser(name: string): Promise<TestUser>;
  /** User A shortcuts (the old single-user API). */
  api: TestUser["api"];
  op: TestUser["op"];
  headers: TestUser["headers"];
  service: MemoryService;
  close(): Promise<void>;
}

export interface TestServerOptions {
  /** Fixes the per-server tag (default random); every user/email the server creates carries it. */
  tag?: string;
  maxPending?: number;
  limiter?: RateLimiter;
  failureLimiter?: FailureLimiter;
  agentFailureLimiter?: FailureLimiter;
  contractLimiter?: FailureLimiter;
  readLimiter?: RateLimiter;
  mcpUrl?: string | null;
  authLimiters?: AuthLimiters;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  trustProxy?: boolean;
  maxMcpTokens?: number;
  /** Per-user storage quotas of the PgStore (default: the production defaults, 5 MB / 5000 memories). */
  quotas?: Partial<Quotas>;
  account?: Partial<AccountConfig>;
  accountOptions?: AccountServiceOptions;
  /** Replace the pool used by the HTTP layer (e.g. a broken one for 503 tests). Data setup still uses the real DB. */
  httpPool?: pg.Pool;
  accounts?: (real: AccountService) => AccountService;
  audit?: PgAudit;
}

const noLimit: FailureLimiter = { blocked: () => false, fail: () => undefined };

/** A real multi-user server on an ephemeral port against TEST_DATABASE_URL, with users A and B pre-provisioned. */
export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  if (!TEST_DB_URL) throw new Error("TEST_DATABASE_URL is not set");
  const pool = createPool({ connectionString: TEST_DB_URL, max: 8 });
  const tag = opts.tag ?? randomUUID().slice(0, 8);
  const store = new PgStore(pool, opts.quotas);
  const services = createMemoryServices({ store });
  const audit = opts.audit ?? createPgAudit(pool);
  const httpPool = opts.httpPool ?? pool;
  const httpStore = opts.httpPool ? new PgStore(opts.httpPool, opts.quotas) : store;
  const hasher = fastHasher();
  const accountCfg: AccountConfig = {
    maxMcpTokens: opts.maxMcpTokens ?? 20,
    allowRegistration: true,
    allowedEmails: [],
    maxUsers: 100_000,
    sessionIdleDays: 7,
    sessionMaxDays: 30,
    ...opts.account,
  };
  const realAccounts = createAccountService(httpPool, httpStore, accountCfg, { hasher, ...opts.accountOptions });
  const accounts = opts.accounts ? opts.accounts(realAccounts) : realAccounts;
  const server = await startHttpServer({
    services: opts.httpPool ? createMemoryServices({ store: httpStore }) : services,
    audit,
    accounts,
    allowedOrigins: opts.allowedOrigins ?? ["http://localhost:5173"],
    allowedHosts: opts.allowedHosts,
    trustProxy: opts.trustProxy,
    limiter: opts.limiter ?? createRateLimiter(),
    // Every test request comes from 127.0.0.1: keep the per-client limiters out of the way unless a test sets them.
    failureLimiter: opts.failureLimiter ?? noLimit,
    agentFailureLimiter: opts.agentFailureLimiter ?? noLimit,
    contractLimiter: opts.contractLimiter ?? noLimit,
    readLimiter: opts.readLimiter,
    mcpUrl: opts.mcpUrl,
    authLimiters: opts.authLimiters ?? { register: noLimit, login: noLimit, config: noLimit },
    maxPending: opts.maxPending,
    host: "127.0.0.1",
    port: 0,
  });
  const url = `http://127.0.0.1:${server.port}`;

  const email = (name: string) => `${name}-${tag}@${tag}.example.test`;
  const password = (name = "x") => `Pw-${tag}-${name}-zebra-lamp`;

  const makeUser = async (name: string): Promise<TestUser> => {
    const displayName = `User ${name.toUpperCase()}`;
    const pw = password(name);
    const row = await pool.query<{ id: string }>(
      "INSERT INTO users (email, display_name, password_hash, password_updated_at) VALUES ($1, $2, $3, now()) RETURNING id",
      [email(name), displayName, await hasher.hash(pw)],
    );
    const id = row.rows[0]!.id;
    await store.ensureWorkspace(id);
    const created = await createSession(pool, id, { idleDays: accountCfg.sessionIdleDays, maxDays: accountCfg.sessionMaxDays }, "vitest");
    const session = created!.token;
    const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${session}`, ...extra });
    const api = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: headers(init.headers as Record<string, string>) });
    return {
      id,
      email: email(name),
      displayName,
      password: pw,
      session,
      service: services.forUser(id),
      headers,
      api,
      op: (op, body = {}) => api(`/api/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      async mcpToken(label = "test") {
        const r = await createToken(pool, id, { label });
        if (!r.ok) throw new Error(`token creation failed: ${r.reason}`);
        return { id: r.id, token: r.token };
      },
      mcpHeaders: (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra }),
    };
  };

  const a = await makeUser("a");
  const b = await makeUser("b");
  let closed = false;
  return {
    url,
    port: server.port,
    pool,
    store,
    services,
    audit,
    accounts,
    tag,
    server,
    a,
    b,
    email,
    password,
    makeUser,
    api: a.api,
    op: a.op,
    headers: a.headers,
    service: a.service,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await audit.flush();
      // audit_log.user_id is ON DELETE SET NULL: remove this server's rows first so none are left behind.
      const ids = `SELECT id FROM users WHERE email LIKE $1`;
      await pool.query(`DELETE FROM audit_log WHERE user_id IN (${ids})`, [`%@${tag}.example.test`]);
      // Throttle rows are keyed by hashes, so they are found through this server's users (login counters and the reauth counter).
      const users = (await pool.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE email LIKE $1`, [`%@${tag}.example.test`])).rows;
      await pool.query("DELETE FROM login_throttle WHERE subject = ANY($1::text[])", [users.flatMap((u) => [emailHash(u.email), u.id])]);
      await pool.query("DELETE FROM users WHERE email LIKE $1", [`%@${tag}.example.test`]); // cascades sessions, tokens + workspaces
      await pool.end();
    },
  };
}

/** Raw HTTP request so the Host header can be forged (fetch hides it). */
export function rawRequest(
  port: number,
  opts: { path: string; method?: string; host: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: { ...opts.headers, Host: opts.host } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** What the old MCP-SDK client was for the tests: an mn_ token plus the client name, talking to /api/agent/* directly. */
export interface AgentClient {
  url: string;
  token: string;
  name: string;
}

/** An agent "connection" (no network round trip): the Authorization header carries the mn_ token, `name` is the announced client. */
export async function connectMcp(url: string, headers: Record<string, string>, name = "test-agent"): Promise<AgentClient> {
  const token = /^Bearer (.+)$/.exec(headers.Authorization ?? "")?.[1];
  if (!token) throw new Error("connectMcp: no bearer token");
  return { url, token, name };
}

/** Calls one tool through POST /api/agent/memory/<tool>; `isError` is any non-200, `data` the JSON body ({error:{code,message}} on errors). */
export async function callTool(c: AgentClient, name: string, args: Record<string, unknown> = {}) {
  const r = await agentPost(c.url, c.token, name, args, { "X-Mnemonis-Client": c.name });
  const raw = await r.text();
  const data = JSON.parse(raw) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { isError: r.status !== 200, status: r.status, data, raw };
}

/**
 * Wraps a real pool so the two `count(*) FROM users` statements of account registration only count the users of one
 * test tag. The test database is shared by parallel test files, so a global user count would be racy.
 */
export function usersScopedToTag(real: pg.Pool, tag: string): pg.Pool {
  const COUNT = "SELECT count(*)::int AS n FROM users";
  const rewrite = (sql: unknown) => (sql === COUNT ? `${COUNT} WHERE email LIKE '%@${tag}.example.test'` : sql);
  const wrapClient = (c: pg.PoolClient): pg.PoolClient =>
    new Proxy(c, {
      get(t, p) {
        if (p === "query") return (sql: unknown, ...a: unknown[]) => (t.query as (...x: unknown[]) => unknown)(rewrite(sql), ...a);
        const v = Reflect.get(t, p) as unknown;
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(real, {
    get(t, p) {
      if (p === "query") return (sql: unknown, ...a: unknown[]) => (t.query as (...x: unknown[]) => unknown)(rewrite(sql), ...a);
      if (p === "connect") return async () => wrapClient(await t.connect());
      const v = Reflect.get(t, p) as unknown;
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/** Headers every /api/agent/* call needs (contract version + JSON body). */
export const agentHeaders = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "X-Mnemonis-Contract": "1",
  ...extra,
});

/** POST /api/agent/memory/<tool> with a valid mn_ token. `tool` is the MCP tool name (memory_save) or the path suffix (save). */
export function agentPost(url: string, token: string, tool: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  const suffix = tool.replace(/^memory_/, "");
  return fetch(`${url}/api/agent/memory/${suffix}`, {
    method: "POST",
    headers: agentHeaders(token, extra),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
