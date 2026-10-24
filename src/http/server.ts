import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import type { AccountService } from "../auth/accounts.js";
import type { AuditLog } from "../audit.js";
import { agentOriginGuard, registerAgentRoutes } from "../agent/routes.js";
import { createRateLimiter, type RateLimiter } from "../service/guards.js";
import type { MemoryServices } from "../service/memoryService.js";
import { createAuthMiddleware, createFailureLimiter, type AppEnv, type FailureLimiter } from "./auth.js";
import { createAuthLimiters, registerPublicAuth, type AuthLimiters } from "./authRoutes.js";
import { corsGuard, errorBody, hostGuard } from "./cors.js";
import { healthBody, registerRest } from "./rest.js";

export interface AppOptions {
  services: MemoryServices;
  audit: AuditLog;
  accounts: AccountService;
  allowedOrigins: string[];
  /** Extra Host header values accepted besides loopback:port (MNEMONIS_ALLOWED_HOSTS). */
  allowedHosts?: string[];
  /** Honour X-Forwarded-For for the pre-auth failure limiter (MNEMONIS_TRUST_PROXY). */
  trustProxy?: boolean;
  getPort: () => number;
  limiter?: RateLimiter;
  /** Counts failed credential checks on /api/* (session), per client. Separate from the /api/agent limiter. */
  failureLimiter?: FailureLimiter;
  /** Per-client limiters of the public register / login / config endpoints. */
  authLimiters?: AuthLimiters;
  maxPending?: number;
  /** Per-user read limiter of /api/agent/* (default 300 per minute). */
  readLimiter?: RateLimiter;
  /** Counts failed credential checks on /api/agent/* per client (its own instance). */
  agentFailureLimiter?: FailureLimiter;
  /** Limiter of the public GET /api/agent/contract. */
  contractLimiter?: FailureLimiter;
  /** The MCP adapter URL published by GET /api/auth/config and named by the 410 of /mcp (null = none). */
  mcpUrl?: string | null;
}

export function createApp(opts: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const guard = { allowedOrigins: opts.allowedOrigins, getPort: opts.getPort, allowedHosts: opts.allowedHosts };
  const limiter = opts.limiter ?? createRateLimiter();
  const authOpts = { accounts: opts.accounts, trustProxy: opts.trustProxy ?? false };
  const apiFailures = opts.failureLimiter ?? createFailureLimiter();

  app.use("*", hostGuard(guard));
  app.use("/api/agent/*", agentOriginGuard); // before CORS: the agent surface never answers (or allows) a browser origin
  app.use("*", corsGuard(guard));
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // Public and registered before the auth middleware: no credentials, no database read, no data.
  app.get("/api/health", (c) => c.json(healthBody()));

  // Public auth endpoints: own per-client limiters and a tiny body limit, no credentials needed.
  registerPublicAuth(app, {
    accounts: opts.accounts,
    audit: opts.audit,
    limiters: opts.authLimiters ?? createAuthLimiters(),
    trustProxy: opts.trustProxy ?? false,
    mcpUrl: opts.mcpUrl ?? null,
  });

  // Internal agent surface (mn_ tokens only): registered BEFORE the session middleware below.
  registerAgentRoutes(app, {
    services: opts.services,
    audit: opts.audit,
    accounts: opts.accounts,
    trustProxy: authOpts.trustProxy,
    failureLimiter: opts.agentFailureLimiter ?? createFailureLimiter(),
    contractLimiter: opts.contractLimiter ?? createFailureLimiter({ max: 60, windowMs: 60_000 }),
    writeLimiter: limiter,
    readLimiter: opts.readLimiter ?? createRateLimiter({ max: 300, noun: "reads" }),
    maxPending: opts.maxPending,
  });

  app.use("/api/*", createAuthMiddleware("session", { ...authOpts, failureLimiter: apiFailures }));
  registerRest(app, { services: opts.services, audit: opts.audit, accounts: opts.accounts, trustProxy: authOpts.trustProxy });

  // The MCP endpoint left this server: it is served by the separate mnemonis_mcp adapter. For one release /mcp answers
  // 410 with the new URL (then it will be a plain 404).
  app.all("/mcp", (c) =>
    c.json(
      errorBody(
        "gone",
        opts.mcpUrl ? `MCP is no longer served by this server. Use the MCP adapter at ${opts.mcpUrl}` : "MCP is no longer served by this server. Use the separate Mnemonis MCP adapter.",
      ),
      410,
    ),
  );

  app.notFound((c) => c.json(errorBody("not_found", "Not found"), 404));
  app.onError((e, c) => {
    // Never echo error details (could contain paths); the class name is enough for the operator log.
    console.error(`request failed: ${e instanceof Error ? e.name : "error"}`);
    return c.json(errorBody("internal", "Internal error"), 500);
  });
  return app;
}

export interface RunningServer {
  port: number;
  /**
   * Stops accepting connections, then waits up to `graceMs` for in-flight requests to finish before dropping the
   * remaining connections. The default (0) drops them immediately.
   */
  close(graceMs?: number): Promise<void>;
}

/** Listens on host:port (port 0 = ephemeral). Rejects on listen errors such as EADDRINUSE. */
export function startHttpServer(opts: Omit<AppOptions, "getPort"> & { host: string; port: number }): Promise<RunningServer> {
  let actualPort = opts.port;
  const app = createApp({ ...opts, getPort: () => actualPort });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info: AddressInfo) => {
      actualPort = info.port;
      server.off("error", reject);
      resolve({
        port: info.port,
        close: (graceMs = 0) =>
          new Promise<void>((res) => {
            const http = server as unknown as HttpServer;
            let timer: NodeJS.Timeout | undefined;
            server.close(() => {
              if (timer) clearTimeout(timer);
              res();
            });
            http.closeIdleConnections?.();
            if (graceMs <= 0) http.closeAllConnections?.();
            else {
              timer = setTimeout(() => http.closeAllConnections?.(), graceMs);
              timer.unref();
            }
          }),
      });
    });
    server.once("error", reject);
  });
}
