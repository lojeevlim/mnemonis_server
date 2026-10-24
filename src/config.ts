import { z } from "zod";
import { normalizeAllowEntry } from "./auth/email.js";
import { assertDatabaseHostAllowed, RemoteDatabaseError } from "./db/guard.js";

export interface Config {
  databaseUrl: string;
  /** Whether POST /api/auth/register is open (default: only on a loopback HOST). */
  allowRegistration: boolean;
  /** Lowercased exact emails and "@domain" entries; empty = any email may register (when registration is open). */
  allowedEmails: string[];
  maxUsers: number;
  /** Sliding idle expiry of a login session, in days. */
  sessionIdleDays: number;
  /** Absolute maximum lifetime of a login session, in days. */
  sessionMaxDays: number;
  allowedOrigins: string[];
  allowedHosts: string[];
  trustProxy: boolean;
  autoMigrate: boolean;
  maxMcpTokens: number;
  /** Per-user cap on the serialized workspace JSON, in bytes. */
  maxWorkspaceBytes: number;
  /** Per-user cap on the number of memories. */
  maxMemories: number;
  /** Concurrent scrypt hashes (each occupies a libuv threadpool thread). */
  hashConcurrency: number;
  /** Inbox cap: unreviewed agent changes per user (MNEMONIS_MAX_PENDING). */
  maxPending: number;
  /** Agent writes per minute per user, shared by all of the user's tokens. */
  agentWritesPerMinute: number;
  /** Agent reads per minute per user. */
  agentReadsPerMinute: number;
  /** The MCP adapter URL shown to users by GET /api/auth/config (MNEMONIS_MCP_URL), or null. */
  mcpUrl: string | null;
  /** MNEMONIS_ADAPTER_SECRET: when set, X-Forwarded-For sent by the adapter (with the matching secret header) is honoured on /api/agent/* only. */
  adapterSecret: string | null;
  host: string;
  port: number;
}

/** Thrown for any invalid configuration. Messages name variables only, never their values. */
export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export const isLoopbackHost = (h: string): boolean => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(h.toLowerCase());

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(empty, s.optional());
const bool = z.enum(["true", "false", "1", "0"]);
const isTrue = (v: string | undefined) => v === "true" || v === "1";

export const DEFAULT_MCP_URL = "http://localhost:8788/mcp";

/** The URL the web app shows in the `claude mcp add` command: https (or http on loopback), path /mcp, no credentials/query/fragment. */
export function validMcpUrl(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
  // The URL ends up in a shell command: only a plain DNS name / IPv4 literal or a bracketed IPv6 literal is accepted.
  const okHost = /^[A-Za-z0-9.-]+$/.test(u.hostname) || /^\[[0-9A-Fa-f:.]+\]$/.test(u.hostname);
  return okScheme && okHost && u.username === "" && u.password === "" && u.search === "" && u.hash === "" && u.pathname === "/mcp" && !v.includes("?") && !v.includes("#");
}

const schema = z.object({
  DATABASE_URL: z.string().trim().min(1, "is required"),
  MNEMONIS_ALLOW_REGISTRATION: opt(bool),
  MNEMONIS_ALLOWED_EMAILS: opt(z.string()),
  MNEMONIS_MAX_USERS: z.preprocess(empty, z.coerce.number().int().min(1).max(1_000_000).default(100)),
  MNEMONIS_SESSION_IDLE_DAYS: z.preprocess(empty, z.coerce.number().int().min(1).max(365).default(7)),
  MNEMONIS_SESSION_MAX_DAYS: z.preprocess(empty, z.coerce.number().int().min(1).max(365).default(30)),
  MNEMONIS_ALLOWED_ORIGINS: opt(z.string()),
  MNEMONIS_ALLOWED_HOSTS: opt(z.string()),
  MNEMONIS_TRUST_PROXY: z.preprocess(empty, bool.default("false")),
  MNEMONIS_AUTO_MIGRATE: z.preprocess(empty, bool.default("false")),
  MNEMONIS_MAX_MCP_TOKENS: z.preprocess(empty, z.coerce.number().int().min(1).max(1000).default(20)),
  MNEMONIS_MAX_WORKSPACE_BYTES: z.preprocess(empty, z.coerce.number().int().min(1024).max(1_073_741_824).default(5 * 1024 * 1024)),
  MNEMONIS_MAX_MEMORIES: z.preprocess(empty, z.coerce.number().int().min(1).max(10_000_000).default(5000)),
  MNEMONIS_HASH_CONCURRENCY: z.preprocess(empty, z.coerce.number().int().min(1).max(16).default(2)),
  MNEMONIS_ALLOW_REMOTE_DB: opt(bool),
  MNEMONIS_MAX_PENDING: z.preprocess(empty, z.coerce.number().int().min(1).max(100_000).default(200)),
  MNEMONIS_AGENT_WRITES_PER_MINUTE: z.preprocess(empty, z.coerce.number().int().min(1).max(100_000).default(60)),
  MNEMONIS_AGENT_READS_PER_MINUTE: z.preprocess(empty, z.coerce.number().int().min(1).max(1_000_000).default(300)),
  MNEMONIS_MCP_URL: opt(z.string().trim()),
  MNEMONIS_PUBLIC_MCP_URL: opt(z.string().trim()),
  MNEMONIS_ADAPTER_SECRET: opt(z.string()),
  HOST: z.preprocess(empty, z.string().trim().default("127.0.0.1")),
  PORT: z.preprocess(empty, z.coerce.number().int().min(0).max(65535).default(8787)),
});

/** Parses and validates the environment. Fails fast with a ConfigError that never includes secret values. */
export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = r.data;
  const problems: string[] = [];

  try {
    assertDatabaseHostAllowed(e.DATABASE_URL, { MNEMONIS_ALLOW_REMOTE_DB: e.MNEMONIS_ALLOW_REMOTE_DB });
  } catch (err) {
    if (!(err instanceof RemoteDatabaseError)) throw err;
    problems.push(err.message);
  }

  const allowedEmails = list(e.MNEMONIS_ALLOWED_EMAILS).map(normalizeAllowEntry);
  if (allowedEmails.some((a) => !/^[^@\s,]*@[^@\s,]+$/.test(a))) {
    problems.push("MNEMONIS_ALLOWED_EMAILS entries must be local@domain or @domain");
  }
  if (e.MNEMONIS_SESSION_IDLE_DAYS > e.MNEMONIS_SESSION_MAX_DAYS) {
    problems.push("MNEMONIS_SESSION_IDLE_DAYS must not exceed MNEMONIS_SESSION_MAX_DAYS");
  }

  // MNEMONIS_PUBLIC_MCP_URL is an alias (the design doc's name); MNEMONIS_MCP_URL wins when both are set.
  const mcpUrl = e.MNEMONIS_MCP_URL ?? e.MNEMONIS_PUBLIC_MCP_URL ?? DEFAULT_MCP_URL;
  if (!validMcpUrl(mcpUrl)) problems.push("MNEMONIS_MCP_URL (or MNEMONIS_PUBLIC_MCP_URL) must be an https URL (or http on localhost) ending in /mcp, without credentials, query or fragment");

  if (e.MNEMONIS_ADAPTER_SECRET !== undefined && !/^[\x21-\x7e]{16,256}$/.test(e.MNEMONIS_ADAPTER_SECRET)) {
    problems.push("MNEMONIS_ADAPTER_SECRET must be 16-256 printable ASCII characters without spaces");
  }

  const allowedOrigins = list(e.MNEMONIS_ALLOWED_ORIGINS);
  // Registration defaults to open only when the server is reachable from this machine alone.
  const allowRegistration = e.MNEMONIS_ALLOW_REGISTRATION === undefined ? isLoopbackHost(e.HOST) : isTrue(e.MNEMONIS_ALLOW_REGISTRATION);
  if (allowRegistration && !isLoopbackHost(e.HOST) && allowedOrigins.length === 0) {
    problems.push("MNEMONIS_ALLOW_REGISTRATION=true on a non-loopback HOST requires an explicit MNEMONIS_ALLOWED_ORIGINS (and ideally MNEMONIS_ALLOWED_EMAILS)");
  }

  if (problems.length > 0) throw new ConfigError([...new Set(problems)]);

  return {
    databaseUrl: e.DATABASE_URL,
    allowRegistration,
    allowedEmails,
    maxUsers: e.MNEMONIS_MAX_USERS,
    sessionIdleDays: e.MNEMONIS_SESSION_IDLE_DAYS,
    sessionMaxDays: e.MNEMONIS_SESSION_MAX_DAYS,
    allowedOrigins,
    allowedHosts: list(e.MNEMONIS_ALLOWED_HOSTS).map((s) => s.toLowerCase()),
    trustProxy: isTrue(e.MNEMONIS_TRUST_PROXY),
    autoMigrate: isTrue(e.MNEMONIS_AUTO_MIGRATE),
    maxMcpTokens: e.MNEMONIS_MAX_MCP_TOKENS,
    maxWorkspaceBytes: e.MNEMONIS_MAX_WORKSPACE_BYTES,
    maxMemories: e.MNEMONIS_MAX_MEMORIES,
    hashConcurrency: e.MNEMONIS_HASH_CONCURRENCY,
    maxPending: e.MNEMONIS_MAX_PENDING,
    agentWritesPerMinute: e.MNEMONIS_AGENT_WRITES_PER_MINUTE,
    agentReadsPerMinute: e.MNEMONIS_AGENT_READS_PER_MINUTE,
    mcpUrl,
    adapterSecret: e.MNEMONIS_ADAPTER_SECRET ?? null,
    host: e.HOST,
    port: e.PORT,
  };
}

/** Startup warnings for the proxy setting (never fatal). Empty when HOST is loopback. */
export function proxyWarnings(cfg: Pick<Config, "host" | "trustProxy">): string[] {
  if (isLoopbackHost(cfg.host)) return [];
  return cfg.trustProxy
    ? ["MNEMONIS_TRUST_PROXY is on: X-Forwarded-For is trusted for the login and failed-auth limiters, so the app must be reachable ONLY through your proxy."]
    : [
        `HOST ${cfg.host} is not loopback and MNEMONIS_TRUST_PROXY is unset: behind a reverse proxy EVERY client shares one login/failed-auth limiter bucket (the proxy's address), so one client can lock out all others. Set MNEMONIS_TRUST_PROXY=true if (and only if) your proxy sets X-Forwarded-For.`,
      ];
}
