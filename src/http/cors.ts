import type { Context, MiddlewareHandler } from "hono";

export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173"];

export function parseAllowedOrigins(env: string | undefined): string[] {
  const list = (env ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_ORIGINS;
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export const deny = (c: Context, status: 400 | 401 | 403 | 404 | 405 | 413 | 428, code: string, message: string) =>
  c.json(errorBody(code, message), status);

export interface GuardOptions {
  /** Exact-match browser origins (never "*"). */
  allowedOrigins: string[];
  /** The port the server is actually listening on (known only after listen when PORT=0). */
  getPort: () => number;
  /** Extra exact (case-insensitive) Host header values accepted besides loopback:port (MNEMONIS_ALLOWED_HOSTS). */
  allowedHosts?: string[];
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * DNS-rebinding defence: loopback names WITH the server's port, plus exact case-insensitive matches of the
 * configured extra hosts (full Host header values), are accepted. Everything else is refused.
 */
export function hostAllowed(host: string | undefined, port: number, extraAllowedHosts: readonly string[] = []): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return LOOPBACK_HOSTS.some((l) => h === `${l}:${port}`) || extraAllowedHosts.some((x) => x.toLowerCase() === h);
}

export function hostGuard(opts: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!hostAllowed(c.req.header("host"), opts.getPort(), opts.allowedHosts)) {
      return deny(c, 403, "forbidden_host", "Host header not allowed");
    }
    await next();
  };
}

const ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type, If-Match, If-None-Match";

/**
 * Origin validation + CORS. Requests without an Origin header (curl, Claude Code, server-to-server) pass;
 * any browser request whose Origin is not on the exact-match list is refused with 403 (also on /mcp).
 * Preflights are answered here (204) before authentication.
 */
export function corsGuard(opts: GuardOptions): MiddlewareHandler {
  const allowed = new Set(opts.allowedOrigins);
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin === undefined) {
      if (c.req.method === "OPTIONS") return c.body(null, 204);
      await next();
      return;
    }
    if (!allowed.has(origin)) return deny(c, 403, "forbidden_origin", "Origin not allowed");
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": "ETag, Retry-After",
      Vary: "Origin",
    };
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        ...cors,
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Max-Age": "600",
      });
    }
    await next();
    try {
      for (const [k, v] of Object.entries(cors)) c.res.headers.set(k, v);
    } catch {
      c.res = new Response(c.res.body, c.res); // immutable headers: clone, then set
      for (const [k, v] of Object.entries(cors)) c.res.headers.set(k, v);
    }
  };
}
