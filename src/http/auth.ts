import { createHash, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { AccountService } from "../auth/accounts.js";
import { TOKEN_RE } from "../auth/apiTokens.js";
import { SESSION_RE } from "../auth/sessions.js";
import { errorBody } from "./cors.js";
import { ipBucket } from "./ip.js";

export interface AuthContext {
  userId: string;
  /** The user's display name (the human actor name on REST writes). */
  displayName: string;
  kind: "session" | "mcp";
  /** Set for MCP tokens only. */
  tokenId?: string;
  /** Set for login sessions only. */
  sessionId?: string;
  /** Set for login sessions only: when the session ends if it is not used again. */
  sessionExpiresAt?: Date;
}

export type AppEnv = { Variables: { auth: AuthContext; viaAdapter?: boolean } };

export const ADAPTER_SECRET_HEADER = "x-mnemonis-adapter-secret";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Timing-safe comparison of a presented secret with the configured one (both hashed first, so lengths do not leak). */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  return presented !== undefined && timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Mounted on /api/agent/* ONLY. When MNEMONIS_ADAPTER_SECRET is configured and the request carries a matching
 * X-Mnemonis-Adapter-Secret, the request came from our own adapter and its X-Forwarded-For (one IP literal, the real
 * MCP client) is honoured by clientKey. A missing or wrong secret is simply ignored: the socket address is used.
 * The secret is never logged or echoed.
 */
export const adapterTrust = (secret: string | null | undefined): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (secret && secretMatches(c.req.header(ADAPTER_SECRET_HEADER), secret)) c.set("viaAdapter", true);
  await next();
};

export const MAX_AUTH_HEADER_CHARS = 8192;
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i; // the auth scheme is case-insensitive (RFC 7235); the credential is not

/** Exactly one, strictly formatted `Authorization: Bearer <credential>` header (scheme case-insensitive), or null. */
export function parseBearer(header: string | undefined | null): string | null {
  if (header === undefined || header === null || header.length > MAX_AUTH_HEADER_CHARS) return null;
  return BEARER_RE.exec(header)?.[1] ?? null;
}

export interface FailureLimiter {
  /** True when this client has used up its failure budget (call before authenticating). */
  blocked(key: string): boolean;
  /** Records one failed authentication. */
  fail(key: string): void;
}

/** Per-client failed-auth counter: `max` failures per window, at most `maxKeys` tracked clients. */
export function createFailureLimiter(opts: { max?: number; windowMs?: number; maxKeys?: number; now?: () => number } = {}): FailureLimiter {
  const { max = 30, windowMs = 60_000, maxKeys = 10_000, now = Date.now } = opts;
  const failures = new Map<string, number[]>();
  const live = (key: string, t: number): number[] => (failures.get(key) ?? []).filter((x) => t - x < windowMs);
  return {
    blocked(key) {
      const t = now();
      const recent = live(key, t);
      if (recent.length === 0) failures.delete(key);
      else failures.set(key, recent);
      return recent.length >= max;
    },
    fail(key) {
      const t = now();
      if (!failures.has(key) && failures.size >= maxKeys) {
        for (const [k, v] of failures) if (v.length === 0 || t - v[v.length - 1] >= windowMs) failures.delete(k);
        for (const k of failures.keys()) {
          if (failures.size < maxKeys) break;
          failures.delete(k);
        }
      }
      const recent = live(key, t);
      recent.push(t);
      failures.set(key, recent.slice(-max));
    },
  };
}

/**
 * Client bucket used for the pre-auth limiters, the login throttle and the audit `client` field: a VALIDATED address
 * (net.isIP), never raw header text. The socket address by default (coarse: clients behind one NAT/proxy share a bucket).
 * X-Forwarded-For is honoured only when MNEMONIS_TRUST_PROXY is set (or, on /api/agent/* only, when the request proved
 * itself to be from the adapter with MNEMONIS_ADAPTER_SECRET, see adapterTrust), and then only its last entry (the one appended by
 * our own proxy); an entry that is not an IP literal falls back to the socket address. IPv6 is bucketed by /64.
 */
export function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy || c.get("viaAdapter") === true) {
    const fromProxy = ipBucket(c.req.header("x-forwarded-for")?.split(",").pop());
    if (fromProxy) return fromProxy;
  }
  try {
    return ipBucket(getConnInfo(c).remote.address) ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface AuthOptions {
  accounts: Pick<AccountService, "verifyMcp" | "verifySession">;
  failureLimiter: FailureLimiter;
  trustProxy: boolean;
  /** Error code of the 429 sent to a client over its failure budget (default "rate_limited"; /api/agent uses "too_many_failed_attempts"). */
  limitedCode?: string;
}

const unauthorized = (c: Context) => {
  c.header("WWW-Authenticate", 'Bearer realm="mnemonis"');
  return c.json(errorBody("unauthorized", "Missing or invalid credentials"), 401);
};

const unavailable = (c: Context, e: unknown) => {
  // Only the error class name is logged: never tokens, claims or driver messages.
  console.error(`auth backend unavailable: ${e instanceof Error ? e.name : "error"}`);
  return c.json(errorBody("unavailable", "Service unavailable"), 503);
};

/**
 * The credential SHAPE picks the verifier; the two are never tried in turn. /api/* takes only a login session
 * (`ms_` + 43 chars), /mcp takes only an `mn_` token of kind mcp. A wrong-shaped credential is refused before any
 * database access, and every credential refusal is the same 401.
 */
export function createAuthMiddleware(kind: "session" | "mcp", o: AuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = clientKey(c, o.trustProxy);
    if (o.failureLimiter.blocked(key)) {
      c.header("Retry-After", "60");
      return c.json(errorBody(o.limitedCode ?? "rate_limited", "Too many failed attempts. Try again later."), 429);
    }
    const refuse = () => {
      o.failureLimiter.fail(key);
      return unauthorized(c);
    };
    const cred = parseBearer(c.req.header("authorization"));
    if (cred === null) return refuse();
    try {
      if (kind === "session") {
        if (!SESSION_RE.test(cred)) return refuse();
        const p = await o.accounts.verifySession(cred);
        if (!p) return refuse();
        c.set("auth", { userId: p.userId, displayName: p.displayName, kind: "session", sessionId: p.sessionId, sessionExpiresAt: p.expiresAt });
      } else {
        if (!TOKEN_RE.test(cred)) return refuse();
        const p = await o.accounts.verifyMcp(cred);
        if (!p) return refuse();
        c.set("auth", { userId: p.userId, displayName: p.displayName, kind: "mcp", tokenId: p.tokenId });
      }
    } catch (e) {
      return unavailable(c, e);
    }
    await next();
  };
}
