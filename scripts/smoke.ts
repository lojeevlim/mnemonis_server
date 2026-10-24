// Smoke test: a throw-away multi-user server (TEST_DATABASE_URL) on a random port.
// Register/login over REST, session-only /api, mcp token creation, the internal /api/agent tools, and the credential-kind separation.
// Never touches ~/.mnemonis. Run it ONLY against a throw-away local database: createPool refuses a remote host
// (see src/db/guard.ts) and the user plus its throttle/audit rows are removed at the end.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { createPgAudit } from "../src/audit.js";
import { createAccountService } from "../src/auth/accounts.js";
import { emailHash } from "../src/auth/throttle.js";
import { createPool } from "../src/db/pool.js";
import { ipBucket } from "../src/http/ip.js";
import { startHttpServer } from "../src/http/server.js";
import { createMemoryServices } from "../src/service/memoryService.js";
import { PgStore } from "../src/store/pgStore.js";

if (process.env.MNEMONIS_ALLOW_REMOTE_DB) {
  console.error("MNEMONIS_ALLOW_REMOTE_DB is set: the smoke test refuses to run (it must only ever touch a local throw-away database). Unset it.");
  process.exit(1);
}
const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.error("TEST_DATABASE_URL is not set (the smoke test uses a throw-away database, never DATABASE_URL).");
  process.exit(1);
}

/** The database must already be migrated (npm run db:migrate with DATABASE_URL pointing at the throw-away database). */
async function assertMigrated(p: ReturnType<typeof createPool>): Promise<void> {
  const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql"));
  let applied: string[];
  try {
    applied = (await p.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "42P01") {
      console.error(`Cannot reach the smoke database (${code ?? (e instanceof Error ? e.message : "unknown error")}). Is TEST_DATABASE_URL correct and the database running?`);
    } else {
      console.error("The smoke database is not migrated. Run `npm run db:migrate` against it first (DATABASE_URL=<the same throw-away database>).");
    }
    await p.end().catch(() => undefined);
    process.exit(1);
  }
  const missing = files.filter((f) => !applied.includes(f));
  if (missing.length) {
    console.error(`The smoke database is missing migrations (${missing.join(", ")}). Run \`npm run db:migrate\` against it first.`);
    await p.end().catch(() => undefined);
    process.exit(1);
  }
}

const tag = randomUUID().slice(0, 8);
const email = `smoke-${tag}@smoke.example.test`;
const password = `smoke-${tag}-correct-horse-battery`;
// Every request carries a unique client address (this server trusts X-Forwarded-For), so the audit rows of this run, and only
// those, are recognisable by their client string at cleanup.
const smokeIp = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
const smokeClient = `ip:${ipBucket(smokeIp)}`;
const realFetch = globalThis.fetch;
const fetch = (url: string, init: RequestInit = {}) => realFetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-Forwarded-For": smokeIp } });
const pool = createPool({ connectionString: dbUrl });
await assertMigrated(pool);
const store = new PgStore(pool);
const audit = createPgAudit(pool);
const server = await startHttpServer({
  services: createMemoryServices({ store }),
  audit,
  accounts: createAccountService(pool, store, { maxMcpTokens: 20, allowRegistration: true, allowedEmails: [], maxUsers: 100_000, sessionIdleDays: 7, sessionMaxDays: 30 }),
  allowedOrigins: ["http://localhost:5173"],
  trustProxy: true,
  host: "127.0.0.1",
  port: 0,
});
const base = `http://127.0.0.1:${server.port}`;
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  const json = { "Content-Type": "application/json" };
  const registered = await fetch(`${base}/api/auth/register`, { method: "POST", headers: json, body: JSON.stringify({ email, password }) });
  const regBody = (await registered.json()) as { token: string };
  check("POST /api/auth/register creates an account and a session", registered.status === 201 && regBody.token?.startsWith("ms_"));
  const loggedIn = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email, password }) });
  const loginBody = (await loggedIn.json()) as { token: string };
  check("POST /api/auth/login returns a session", loggedIn.status === 200 && loginBody.token?.startsWith("ms_"));
  const wrong = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ email, password: "wrong-password-123" }) });
  check("wrong password -> 401 invalid_credentials", wrong.status === 401);
  const session = loginBody.token;
  const sessionAuth = { Authorization: `Bearer ${session}` };

  const health = await fetch(`${base}/api/health`);
  const healthText = await health.text();
  check("GET /api/health (no auth) is exactly {ok:true}", health.status === 200 && healthText === '{"ok":true}', healthText);

  const lower = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `bearer ${session}` } });
  check("the Bearer scheme is case-insensitive", lower.status === 200);

  check("GET /api/state without credentials -> 401", (await fetch(`${base}/api/state`)).status === 401);

  const state = await fetch(`${base}/api/state`, { headers: sessionAuth });
  const stateBody = (await state.json()) as { rev: number };
  check("session GET /api/state (workspace exists)", state.status === 200 && stateBody.rev === 0, `rev=${stateBody.rev}`);

  const minted = await fetch(`${base}/api/tokens`, { method: "POST", headers: { ...sessionAuth, "Content-Type": "application/json" }, body: JSON.stringify({ label: "smoke" }) });
  const mintedBody = (await minted.json()) as { token: string };
  check("session POST /api/tokens creates an mcp token", minted.status === 201 && mintedBody.token?.startsWith("mn_"));
  const mcpAuth = { Authorization: `Bearer ${mintedBody.token}` };

  // The internal agent surface (what the MCP adapter calls): mn_ token + contract header, one POST per tool.
  const agentHeaders = { ...mcpAuth, "Content-Type": "application/json", "X-Mnemonis-Contract": "1" };
  const ping = await fetch(`${base}/api/agent/ping`, { headers: agentHeaders });
  check("GET /api/agent/ping with the mcp token", ping.status === 200 && JSON.stringify(await ping.json()) === '{"ok":true,"contract":1}');
  const contract = await fetch(`${base}/api/agent/contract`);
  const contractBody = (await contract.json()) as { tools: string[] };
  check("GET /api/agent/contract lists 11 tools", contract.status === 200 && contractBody.tools.length === 11, `${contractBody.tools.length} tools`);
  const call = await fetch(`${base}/api/agent/memory/save`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ title: "From the agent API" }) });
  const payload = (await call.json()) as { status: string; message: string; revisionId: string };
  check("agent memory_save is pending", call.status === 200 && payload.status === "pending", payload.message);

  const sessionOnAgent = await fetch(`${base}/api/agent/ping`, { headers: { ...sessionAuth, "X-Mnemonis-Contract": "1" } });
  check("session on /api/agent -> 401", sessionOnAgent.status === 401);
  const gone = await fetch(`${base}/mcp`, { method: "POST", headers: mcpAuth, body: "{}" });
  check("/mcp is gone (410), the MCP adapter is a separate server", gone.status === 410);

  const approveBody = JSON.stringify({ revisionId: payload.revisionId });
  const mcpApprove = await fetch(`${base}/api/ops/approve`, { method: "POST", headers: { ...mcpAuth, "Content-Type": "application/json" }, body: approveBody });
  check("mcp token on /api/ops/approve -> 401", mcpApprove.status === 401);

  const approve = await fetch(`${base}/api/ops/approve`, { method: "POST", headers: { ...sessionAuth, "Content-Type": "application/json" }, body: approveBody });
  check("session approve works", approve.status === 200, `status ${approve.status}`);
} finally {
  await server.close();
  await audit.flush();
  // audit_log.user_id is ON DELETE SET NULL, so delete this run's audit rows before the user (sessions/tokens/workspace cascade).
  await pool.query("DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = $1)", [email]);
  await pool.query("DELETE FROM login_throttle WHERE subject = $1", [emailHash(email)]);
  await pool.query("DELETE FROM users WHERE email = $1", [email]); // cascades sessions, tokens, workspace and known_login_ips
  await pool.query("DELETE FROM audit_log WHERE client = $1", [smokeClient]); // failed attempts have no user_id; only this run's unique client
  await pool.end();
}
console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
