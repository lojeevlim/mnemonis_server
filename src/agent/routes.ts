import { randomUUID } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { idsOf, type AuditLog } from "../audit.js";
import { adapterTrust, clientKey, createAuthMiddleware, type AppEnv, type FailureLimiter } from "../http/auth.js";
import { errorBody } from "../http/cors.js";
import { statusFor } from "../http/rest.js";
import type { AccountService } from "../auth/accounts.js";
import { toErrorInfo } from "../service/errors.js";
import { agentActor, createAgentWriter, RateLimitedError, type RateLimiter } from "../service/guards.js";
import type { MemoryServices } from "../service/memoryService.js";
import { createAgentHandlers, type HandlerResult } from "./handlers.js";
import { AGENT_CONTRACT_VERSION, AGENT_SCHEMAS, isReadTool, TOOL_NAMES, toolPath, type ToolName } from "./schemas.js";

export const AGENT_BODY_LIMIT_BYTES = 512 * 1024;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const CLIENT_NAME_RE = /^[\x20-\x7e]{1,100}$/;

/** Limiter bucket of one user: shared by all of that user's tokens. */
export const agentLimitKey = (userId: string): string => `u:${userId}`;

export interface AgentRouteOptions {
  services: MemoryServices;
  audit: AuditLog;
  accounts: Pick<AccountService, "verifyMcp" | "verifySession">;
  trustProxy: boolean;
  /** MNEMONIS_ADAPTER_SECRET: lets the adapter's X-Forwarded-For be honoured on this surface only (null/unset = never). */
  adapterSecret?: string | null;
  /** Pre-auth failure limiter of this surface (its own instance). */
  failureLimiter: FailureLimiter;
  /** Limiter of the public /api/agent/contract endpoint. */
  contractLimiter: FailureLimiter;
  /** Write limiter (per user). */
  writeLimiter: RateLimiter;
  /** Read limiter (per user). */
  readLimiter: RateLimiter;
  maxPending?: number;
}

/**
 * Must be registered BEFORE the generic CORS guard: this surface is for servers, not browsers, so ANY Origin header is
 * refused (no CORS headers are ever added).
 */
export const agentOriginGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.header("origin") !== undefined) return c.json(errorBody("forbidden_origin", "Origin not allowed"), 403);
  await next();
};

/** Request id (valid inbound one, else a fresh one) + the fixed response headers of this surface. */
export const agentEnvelope: MiddlewareHandler = async (c, next) => {
  const inbound = c.req.header("x-request-id");
  const requestId = inbound !== undefined && REQUEST_ID_RE.test(inbound) ? inbound : randomUUID();
  c.header("X-Request-Id", requestId);
  c.header("X-Mnemonis-Contract", String(AGENT_CONTRACT_VERSION));
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
};

const err = (c: Context, status: 400 | 413 | 415 | 426 | 500, code: string, message: string) => c.json(errorBody(code, message), status);

/**
 * Mounts GET /api/agent/{contract,ping} and POST /api/agent/memory/<tool>. Every route below the auth middleware runs
 * only for a verified `mn_` token; the user id comes from it and nowhere else, and the actor is ALWAYS an agent.
 * Registered before the session middleware, so a login session never reaches (or is accepted by) this surface.
 */
export function registerAgentRoutes(app: Hono<AppEnv>, o: AgentRouteOptions): void {
  app.use("/api/agent/*", agentEnvelope);
  app.use("/api/agent/*", adapterTrust(o.adapterSecret));

  // Public, tiny, limited: lets the adapter detect a contract it does not support.
  app.get("/api/agent/contract", (c) => {
    const ip = clientKey(c, o.trustProxy);
    if (o.contractLimiter.blocked(ip)) {
      c.header("Retry-After", "60");
      return c.json(errorBody("rate_limited", "Too many requests. Try again later."), 429);
    }
    o.contractLimiter.fail(ip);
    return c.json({ contract: "mnemonis-agent", version: AGENT_CONTRACT_VERSION, minSupported: 1, tools: [...TOOL_NAMES] });
  });

  app.use(
    "/api/agent/*",
    createAuthMiddleware("mcp", { accounts: o.accounts, failureLimiter: o.failureLimiter, trustProxy: o.trustProxy, limitedCode: "too_many_failed_attempts" }),
  );
  app.use("/api/agent/*", async (c, next) => {
    if (c.req.header("x-mnemonis-contract") !== String(AGENT_CONTRACT_VERSION)) {
      return err(c, 426, "contract_unsupported", `This server speaks /api/agent contract ${AGENT_CONTRACT_VERSION}; send X-Mnemonis-Contract: ${AGENT_CONTRACT_VERSION}`);
    }
    await next();
  });

  app.get("/api/agent/ping", (c) => c.json({ ok: true, contract: AGENT_CONTRACT_VERSION }));

  for (const name of TOOL_NAMES) {
    app.post(`/api/agent${toolPath(name)}`, bodyLimit({ maxSize: AGENT_BODY_LIMIT_BYTES, onError: (c) => err(c, 413, "too_large", "Request body is too large") }), (c) =>
      callTool(c, name, o),
    );
  }

  // Anything else below /api/agent is a plain 404 (never falls through to the session middleware).
  app.all("/api/agent/*", (c) => c.json(errorBody("not_found", "Not found"), 404));
}

async function callTool(c: Context<AppEnv>, name: ToolName, o: AgentRouteOptions): Promise<Response> {
  if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) {
    return err(c, 415, "unsupported_media_type", "Content-Type must be application/json");
  }
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return err(c, 400, "invalid_input", "Request body is not valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return err(c, 400, "invalid_input", "Request body must be a JSON object");
  const parsed = (AGENT_SCHEMAS[name] as z.ZodType).safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
      .join("; ");
    return err(c, 400, "invalid_input", msg);
  }
  const args = parsed.data as Record<string, unknown>;

  const { userId } = c.get("auth");
  const announced = c.req.header("x-mnemonis-client");
  const actor = agentActor(announced !== undefined && CLIENT_NAME_RE.test(announced) ? announced : null);
  const service = o.services.forUser(userId);
  const key = agentLimitKey(userId);
  const writer = createAgentWriter({ service, clientName: actor.name, limiter: o.writeLimiter, limitKey: key, maxPending: o.maxPending });
  const handlers = createAgentHandlers({ service, writer, maxPending: o.maxPending });

  try {
    if (isReadTool(name)) o.readLimiter.take(key);
    const { data, ids }: HandlerResult = await (handlers[name] as (a: unknown) => Promise<HandlerResult>)(args);
    o.audit.record({ userId, via: "mcp", client: actor.name, action: name, ids: idsOf(args, ...(ids ?? [])), ok: true });
    return c.json(data);
  } catch (e) {
    const info = toErrorInfo(e);
    o.audit.record({ userId, via: "mcp", client: actor.name, action: name, ids: idsOf(args), ok: false, code: info.code });
    if (e instanceof RateLimitedError) c.header("Retry-After", String(e.retryAfter));
    return c.json(errorBody(info.code, info.message), statusFor(info.code));
  }
}
