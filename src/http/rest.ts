import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { idsOf, type AuditLog } from "../audit.js";
import { assertActor, MAX_IMPORT_BYTES, type Actor, type Json } from "../domain/index.js";
import { StoreError } from "../store/types.js";
import { toErrorInfo } from "../service/errors.js";
import { agentRelationProvenance, safeAgentName } from "../service/guards.js";
import type { MemoryService, MemoryServices } from "../service/memoryService.js";
import { AccountError, type AccountService } from "../auth/accounts.js";
import { PasswordBusyError } from "../auth/password.js";
import { ThrottleBusyError } from "../auth/throttle.js";
import { clientKey, type AppEnv } from "./auth.js";
import { errorBody } from "./cors.js";

/** Ordinary request bodies (ops, MCP). Imports (PUT /api/state) use MAX_IMPORT_BYTES. */
export const MAX_BODY_BYTES = 1024 * 1024;

export function statusFor(code: string): ContentfulStatusCode {
  switch (code) {
    case "memory_not_found":
    case "relation_not_found":
    case "revision_not_found":
    case "collection_not_found":
    case "unknown_op":
      return 404;
    case "invalid_input":
      return 400;
    case "too_large":
      return 422;
    case "forbidden":
      return 403;
    case "not_pending":
    case "proposal_outdated":
    case "duplicate_id":
    case "duplicate_relation":
    case "collection_not_empty":
    case "endpoint_not_saved":
    case "not_saved":
    case "memory_archived":
    case "conflict":
      return 409;
    case "rate_limited":
    case "inbox_full":
      return 429;
    default:
      return 500;
  }
}

export function fail(c: Context, e: unknown) {
  const info = toErrorInfo(e);
  return c.json(errorBody(info.code, info.message), statusFor(info.code));
}

// ---- strict argument schemas (one per op; the body IS the args, minus the actor, which the server decides: see effectiveActor) ----

const id = z.string().min(1).max(200);
const text = (max: number) => z.string().max(max);
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
const metadata = z.record(z.string(), jsonValue);
const tags = z.array(text(1000)).max(1000);
const provenance = z.strictObject({ origin: text(100), createdBy: text(200) });
const relProvenance = z.strictObject({
  origin: z.enum(["user", "process"]),
  createdBy: text(200),
  process: text(200).optional(),
  demo: z.boolean().optional(),
});
const patch = z.strictObject({
  title: text(10_000).optional(),
  content: text(MAX_BODY_BYTES).optional(),
  type: z.string().min(1).max(100).optional(),
  tags: tags.optional(),
  collectionId: id.nullable().optional(),
  metadata: metadata.optional(),
});
/** Optional body `actor` on memory/relation write ops. Downgrade-only: only kind "agent" is ever honoured. */
export const agentActorSchema = z.strictObject({ kind: z.literal("agent"), name: z.string().min(1).max(100) });
const bulk = z.strictObject({ revisionIds: z.array(id).max(10_000).optional(), relationIds: z.array(id).max(10_000).optional() });

type Svc = MemoryService;
type OpResult = Promise<{ rev: number; state: unknown; value: unknown }>;
interface Op {
  schema: z.ZodType;
  /** True when a body `actor` of kind "agent" may downgrade the write to a pending proposal. */
  agentWritable: boolean;
  run: (svc: Svc, args: never, actor: Actor) => OpResult;
}
const op = <S extends z.ZodType>(
  schema: S,
  run: (svc: Svc, args: z.infer<S>, actor: Actor) => OpResult,
  agentWritable = false,
): Op => ({
  schema,
  agentWritable,
  run: run as Op["run"],
});

/**
 * Whitelist of the web MemoryRepository mutation names (same names, same argument shapes minus `actor`,
 * which is the server-side human user unless a write op carries an agent actor, see effectiveActor). Nothing else is reachable through /api/ops.
 */
export const OPS = {
  createMemory: op(
    z.strictObject({
      id: id.optional(),
      title: text(10_000),
      content: text(MAX_BODY_BYTES).optional(),
      type: z.string().min(1).max(100).optional(),
      tags: tags.optional(),
      collectionId: id.nullable().optional(),
      source: text(100).optional(),
      provenance: provenance.optional(),
      metadata: metadata.optional(),
    }),
    (s, a, actor) => s.createMemory({ ...a, actor }),
    true,
  ),
  updateMemory: op(z.strictObject({ id, patch }), (s, a, actor) => s.updateMemory({ ...a, actor }), true),
  archiveMemory: op(z.strictObject({ id }), (s, a, actor) => s.archiveMemory({ ...a, actor }), true),
  restoreMemory: op(z.strictObject({ id }), (s, a, actor) => s.restoreMemory({ ...a, actor }), true),
  rollbackMemory: op(z.strictObject({ memoryId: id, toRevisionId: id }), (s, a, actor) => s.rollbackMemory({ ...a, actor }), true),
  addRelation: op(
    z.strictObject({ fromId: id, toId: id, label: text(1000), provenance: relProvenance.optional() }),
    // An agent never chooses its provenance (it could forge the domain's title-prefix auto-link marker).
    (s, a, actor) =>
      s.addRelation({ ...a, actor, ...(actor.kind === "agent" ? { provenance: agentRelationProvenance(actor) } : {}) }),
    true,
  ),
  removeRelation: op(z.strictObject({ id }), (s, a, actor) => s.removeRelation({ ...a, actor })),
  createCollection: op(z.strictObject({ name: text(1000), description: text(10_000).optional() }), (s, a) => s.createCollection(a)),
  updateCollection: op(
    z.strictObject({ id, name: text(1000).optional(), description: text(10_000).optional() }),
    (s, a) => s.updateCollection(a),
  ),
  deleteCollection: op(z.strictObject({ id }), (s, a) => s.deleteCollection(a)),
  approve: op(z.strictObject({ revisionId: id }), (s, a, actor) => s.approveRevision({ ...a, actor })),
  reject: op(z.strictObject({ revisionId: id }), (s, a, actor) => s.rejectRevision({ ...a, actor })),
  approveRelation: op(z.strictObject({ relationId: id }), (s, a, actor) => s.approveRelation({ ...a, actor })),
  rejectRelation: op(z.strictObject({ relationId: id }), (s, a, actor) => s.rejectRelation({ ...a, actor })),
  approveAll: op(bulk, (s, a, actor) => s.approveAll({ ...a, actor })),
  rejectAll: op(bulk, (s, a, actor) => s.rejectAll({ ...a, actor })),
  approveAllDetailed: op(bulk, (s, a, actor) => s.approveAllDetailed({ ...a, actor })),
  rejectAllDetailed: op(bulk, (s, a, actor) => s.rejectAllDetailed({ ...a, actor })),
} as const;

export type OpName = keyof typeof OPS;

const etag = (rev: number) => `"${rev}"`;

/** Parses If-Match / If-None-Match: `"5"`, `W/"5"` or `5`. Returns null when not a revision. */
function parseRev(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(header);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Downgrade-only actor rule for POST /api/ops. The server's user actor is the default. A body `actor` is honoured
 * ONLY when the op is a memory/relation write (agentWritable) and the actor is exactly kind "agent" with a name
 * that passes the domain's assertActor (1..100 chars, no control characters); the write then lands pending.
 * Everything else (kind "user", missing, malformed, or any actor on a review op incl. removeRelation) is
 * silently ignored: the request runs as the server's user. A body can never upgrade an actor.
 */
export function effectiveActor(def: Op, claimed: unknown, user: Actor): Actor {
  if (!def.agentWritable || claimed === null || typeof claimed !== "object") return user;
  try {
    assertActor(claimed);
  } catch {
    return user;
  }
  if (claimed.kind !== "agent" || !agentActorSchema.safeParse({ kind: claimed.kind, name: claimed.name.trim() }).success) return user;
  return { kind: "agent", name: safeAgentName(claimed.name.trim()) };
}

const cleanName = (n: string): string => {
  // eslint-disable-next-line no-control-regex
  const v = n.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100);
  return v || "local-user";
};

export interface RestOptions {
  services: MemoryServices;
  audit: AuditLog;
  accounts: AccountService;
  /** Honour X-Forwarded-For for the client IP bucket (MNEMONIS_TRUST_PROXY). */
  trustProxy?: boolean;
}

/** Maps a service error to the HTTP response. Anything that is not a deliberate refusal is an outage: 503 with the class name logged. */
export function accountFailure(c: Context, e: unknown) {
  if (e instanceof AccountError) {
    if (e.retryAfter !== undefined) c.header("Retry-After", String(e.retryAfter));
    return c.json(errorBody(e.code, e.message), e.status);
  }
  if (e instanceof PasswordBusyError || e instanceof ThrottleBusyError) {
    c.header("Retry-After", "5");
    return c.json(errorBody("busy", "Server is busy. Try again shortly."), 503);
  }
  console.error(`account operation failed: ${e instanceof Error ? e.name : "error"}`);
  return c.json(errorBody("unavailable", "Service unavailable"), 503);
}

export async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await c.req.text()) };
  } catch {
    return { ok: false };
  }
}

// currentPassword / password have no max: an oversize one is simply "incorrect" (the 4 KB body limit bounds the request).
const passwordChangeBody = z.strictObject({ currentPassword: z.string(), newPassword: z.string().max(1024) });
const deleteAccountBody = z.strictObject({ password: z.string() });
const MAX_PASSWORD_BODY_BYTES = 4 * 1024;

const tokenBody = z.strictObject({ label: z.string().max(500), expiresInDays: z.number().int().min(1).max(365).optional() });
const MAX_TOKEN_BODY_BYTES = 16 * 1024;

/**
 * Mounts the authenticated REST API. Host/Origin/auth are applied by the caller (server.ts): every handler here
 * runs only with `c.get("auth")` set to a session-authenticated user, and takes the user id from it and nowhere else.
 */
export function registerRest(app: Hono<AppEnv>, { services, audit, accounts, trustProxy = false }: RestOptions): void {
  const noStore = (c: Context) => c.header("Cache-Control", "no-store");
  const who = (c: Context<AppEnv>) => {
    const a = c.get("auth");
    const user: Actor = { kind: "user", name: cleanName(a.displayName) };
    return { userId: a.userId, svc: services.forUser(a.userId), user };
  };

  const me = async (c: Context<AppEnv>) => {
    const a = c.get("auth");
    const p = await accounts.profile(a.userId);
    if (!p) return c.json(errorBody("not_found", "Not found"), 404);
    return c.json({ id: p.id, email: p.email, displayName: p.displayName, session: { expiresAt: a.sessionExpiresAt?.toISOString() ?? null } });
  };
  app.get("/api/auth/me", me);
  app.get("/api/me", me); // alias kept for one release

  app.post("/api/auth/logout", async (c) => {
    const a = c.get("auth");
    const { user } = who(c);
    await accounts.logout(a.userId, a.sessionId!);
    audit.record({ userId: a.userId, via: "rest", client: user.name, actorKind: "user", action: "auth:logout", ok: true });
    return c.body(null, 204);
  });

  app.post("/api/auth/password", bodyLimit({ maxSize: MAX_PASSWORD_BODY_BYTES, onError: tooBig }), async (c) => {
    const a = c.get("auth");
    const { user } = who(c);
    const raw = await readJson(c);
    const parsed = raw.ok ? passwordChangeBody.safeParse(raw.value) : null;
    if (!parsed?.success) return c.json(errorBody("invalid_input", "Body must be {currentPassword, newPassword}"), 400);
    try {
      const ip = clientKey(c, trustProxy);
      await accounts.changePassword(a.userId, a.sessionId!, parsed.data.currentPassword, parsed.data.newPassword, { ip: ip === "unknown" ? null : ip });
      audit.record({ userId: a.userId, via: "rest", client: user.name, actorKind: "user", action: "auth:password", ok: true });
      return c.body(null, 204);
    } catch (e) {
      audit.record({ userId: a.userId, via: "rest", client: user.name, actorKind: "user", action: "auth:password", ok: false, code: e instanceof AccountError ? e.code : "unavailable" });
      return accountFailure(c, e);
    }
  });

  app.delete("/api/auth/me", bodyLimit({ maxSize: MAX_PASSWORD_BODY_BYTES, onError: tooBig }), async (c) => {
    const a = c.get("auth");
    const { user } = who(c);
    const raw = await readJson(c);
    const parsed = raw.ok ? deleteAccountBody.safeParse(raw.value) : null;
    if (!parsed?.success) return c.json(errorBody("invalid_input", "Body must be {password}"), 400);
    try {
      await accounts.deleteAccount(a.userId, parsed.data.password);
      // The user row is gone, so the entry carries no user id.
      audit.record({ userId: null, via: "rest", client: "account-deleted", actorKind: "user", action: "auth:delete", ok: true });
      return c.body(null, 204);
    } catch (e) {
      audit.record({ userId: a.userId, via: "rest", client: user.name, actorKind: "user", action: "auth:delete", ok: false, code: e instanceof AccountError ? e.code : "unavailable" });
      return accountFailure(c, e);
    }
  });

  app.get("/api/tokens", async (c) => {
    const list = await accounts.listTokens(who(c).userId);
    return c.json({
      tokens: list.map((t) => ({
        id: t.id,
        label: t.label,
        prefix: t.prefix,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt,
        revokedAt: t.revokedAt,
      })),
    });
  });

  app.post("/api/tokens", bodyLimit({ maxSize: MAX_TOKEN_BODY_BYTES, onError: tooBig }), async (c) => {
    const { userId, user } = who(c);
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json(errorBody("invalid_input", "Request body is not valid JSON"), 400);
    }
    const parsed = tokenBody.safeParse(raw);
    if (!parsed.success) return c.json(errorBody("invalid_input", "Body must be {label: string, expiresInDays?: 1-365}"), 400);
    const r = await accounts.createToken(userId, parsed.data);
    if (!r.ok) {
      // Audited by outcome only: the request body (label) is never recorded.
      audit.record({ userId, via: "rest", client: user.name, actorKind: "user", action: "token:create", ok: false, code: r.reason === "limit" ? "token_limit_reached" : "invalid_input" });
      return r.reason === "limit"
        ? c.json(errorBody("token_limit_reached", "Too many active tokens; revoke one first"), 409)
        : c.json(errorBody("invalid_input", "Invalid label or expiry"), 400);
    }
    // Only the token id is audited: the response body (which carries the one-time plaintext) never reaches the audit.
    audit.record({ userId, via: "rest", client: user.name, actorKind: "user", action: "token:create", ids: [r.id], ok: true });
    return c.json(
      { id: r.id, token: r.token, prefix: r.prefix, label: r.label, createdAt: r.createdAt, expiresAt: r.expiresAt },
      201,
    );
  });

  app.delete("/api/tokens/:id", async (c) => {
    const { userId, user } = who(c);
    const id = c.req.param("id");
    const r = await accounts.revokeToken(userId, id);
    if (r === "not_found") return c.json(errorBody("not_found", "Not found"), 404);
    if (r === "revoked") audit.record({ userId, via: "rest", client: user.name, actorKind: "user", action: "token:revoke", ids: [id], ok: true });
    return c.body(null, 204);
  });

  app.get("/api/state", async (c) => {
    const { svc } = who(c);
    const snap = await svc.getState();
    noStore(c);
    c.header("ETag", etag(snap.rev));
    if (parseRev(c.req.header("if-none-match")) === snap.rev) return c.body(null, 304);
    return c.json({ rev: snap.rev, state: snap.state });
  });

  app.put("/api/state", bodyLimit({ maxSize: MAX_IMPORT_BYTES, onError: tooBig }), async (c) => {
    const { userId, svc, user } = who(c);
    const header = c.req.header("if-match");
    if (header === undefined) {
      return c.json(errorBody("precondition_required", "If-Match header with the current revision is required"), 428);
    }
    const rev = parseRev(header);
    if (rev === null) return c.json(errorBody("invalid_input", "If-Match must be a revision number"), 400);
    try {
      const snap = await svc.importJson(await c.req.text(), { ifMatchRev: rev });
      audit.record({ userId, via: "rest", client: user.name, action: "import", ok: true });
      noStore(c);
      c.header("ETag", etag(snap.rev));
      return c.json({ rev: snap.rev, state: snap.state });
    } catch (e) {
      const info = toErrorInfo(e);
      audit.record({ userId, via: "rest", client: user.name, action: "import", ok: false, code: info.code });
      if (e instanceof StoreError && e.code === "conflict") {
        const current = (await svc.getState()).rev;
        c.header("ETag", etag(current));
        return c.json({ error: { code: "conflict", message: e.message }, currentRev: current }, 409);
      }
      if (e instanceof StoreError && e.code === "too_large") return c.json(errorBody("too_large", e.message), 413); // storage quota
      return fail(c, e);
    }
  });

  app.get("/api/export", async (c) => {
    const json = await who(c).svc.exportJson();
    noStore(c);
    c.header("Content-Disposition", 'attachment; filename="mnemonis-export.json"');
    return c.body(json, 200, { "Content-Type": "application/json; charset=UTF-8" });
  });

  app.post("/api/ops/:name", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooBig }), async (c) => {
    const { userId, svc: service, user } = who(c);
    const name = c.req.param("name");
    if (!Object.hasOwn(OPS, name)) return c.json(errorBody("unknown_op", "Unknown operation"), 404);
    const def: Op = OPS[name as OpName];

    let body: unknown;
    const raw = await c.req.text();
    try {
      body = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return c.json(errorBody("invalid_input", "Request body is not valid JSON"), 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json(errorBody("invalid_input", "Request body must be a JSON object"), 400);
    }
    // `actor` is stripped before strict validation; effectiveActor decides what (if anything) of it is honoured.
    const { actor: claimed, ...args } = body as Record<string, unknown>;
    const actor = effectiveActor(def, claimed, user);
    const parsed = def.schema.safeParse(args);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
        .join("; ");
      return c.json(errorBody("invalid_input", msg), 400);
    }
    try {
      const r = await def.run(service, parsed.data as never, actor);
      audit.record({ userId, via: "rest", client: actor.name, actorKind: actor.kind, action: `op:${name}`, ids: idsOf(parsed.data, r.value), ok: true });
      noStore(c);
      c.header("ETag", etag(r.rev));
      return c.json({ rev: r.rev, state: r.state, value: r.value ?? null });
    } catch (e) {
      const info = toErrorInfo(e);
      audit.record({ userId, via: "rest", client: actor.name, actorKind: actor.kind, action: `op:${name}`, ids: idsOf(parsed.data), ok: false, code: info.code });
      return fail(c, e);
    }
  });
}

export const tooBig = (c: Context) => c.json(errorBody("too_large", "Request body is too large"), 413);

/** Exactly {ok:true}: no revision, no schema version, no database read. */
export const healthBody = () => ({ ok: true }) as const;
