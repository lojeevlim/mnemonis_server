import {
  addRelation,
  archiveMemory,
  createMemory,
  DomainError,
  pendingRevisionFor,
  updateMemory,
  type Actor,
  type Memory,
  type MemoryPatch,
  type MemoryType,
  type Metadata,
  type Relation,
  type WorkspaceState,
} from "../domain/index.js";
import type { MemoryService, Result } from "./memoryService.js";

export const MAX_PENDING_AGENT_ITEMS = 200;
export const MAX_RELATION_LABEL = 200;
const DEFAULT_AGENT_NAME = "claude-code";
const MAX_ACTOR_NAME = 100;
/**
 * Relation provenance.process values the domain reserves for its own auto-links: "title-prefix" (the "part of"
 * links, src/domain/titlePrefix.ts) and "topic-tag" (the "shares topic: <tag>" links, src/domain/topicLinks.ts).
 * Plain strings on purpose: an agent name must never equal one, because agent relations use the actor name as
 * their process, and the marker (label + process) tells the domain which links it may drop or rebuild.
 * The domain's isAuto/marker checks are exact-match; the case-insensitive compare below is defence in depth.
 */
const RESERVED_AGENT_PROCESSES: ReadonlySet<string> = new Set(["title-prefix", "topic-tag"]);

/** Maps an (already trimmed) agent name that collides with a reserved process marker to a safe one. */
export function safeAgentName(name: string): string {
  return RESERVED_AGENT_PROCESSES.has(name.toLowerCase()) ? `${name}-client` : name;
}

/** The ONLY way the MCP path builds an actor: always kind "agent"; the name is cleaned client input. */
export function agentActor(clientName?: string | null): Actor {
  // eslint-disable-next-line no-control-regex
  const name = (clientName ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_ACTOR_NAME);
  return { kind: "agent", name: safeAgentName(name || DEFAULT_AGENT_NAME) };
}

/** Server-built provenance for an agent's relation; never client-supplied, never the reserved auto-link process. */
export function agentRelationProvenance(actor: Actor): { origin: "process"; createdBy: string; process: string } {
  const name = safeAgentName(actor.name);
  return { origin: "process", createdBy: name, process: name };
}

/** Pending items waiting for review that an agent created (memory proposals + links). */
export function pendingAgentItems(state: WorkspaceState): number {
  let n = 0;
  for (const r of Object.values(state.revisions)) if (r.status === "pending" && r.origin === "agent") n++;
  for (const r of Object.values(state.relations)) if (r.status === "pending") n++;
  return n;
}

function assertInboxHasRoom(state: WorkspaceState, cap: number): void {
  // Note: the domain also creates pending auto-links as part of an agent write ("part of" title-prefix links and
  // "shares topic: <tag>" topic links), so one write can overshoot this cap by that fan-out. Topic links are
  // bounded in the domain (12 per call, 3 per project per topic); the overshoot overall is bounded by the
  // workspace quota (src/store/quota.ts).
  if (pendingAgentItems(state) >= cap) {
    throw new DomainError(
      "inbox_full",
      `The Inbox already holds ${cap} unreviewed agent changes. Ask the user to review the Inbox in the Mnemonis app before saving more.`,
    );
  }
}

/** A DomainError "rate_limited" that also says how many seconds to wait (the /api/agent surface sends it as Retry-After). */
export class RateLimitedError extends DomainError {
  readonly retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super("rate_limited", message);
    this.retryAfter = retryAfter;
  }
}

export interface RateLimiter {
  /** Records one write for `key`; throws DomainError "rate_limited" when over the limit. */
  take(key: string): void;
}

/** Sliding-window limiter (default 60 writes / minute / key, at most 10,000 tracked keys). */
export function createRateLimiter(
  opts: { max?: number; windowMs?: number; maxKeys?: number; now?: () => number; noun?: string } = {},
): RateLimiter {
  const { noun = "writes", max = 60, windowMs = 60_000, maxKeys = 10_000, now = Date.now } = opts;
  const hits = new Map<string, number[]>();
  /** Drops keys whose newest hit left the window; if still full, evicts the oldest-inserted keys. */
  const makeRoom = (t: number) => {
    for (const [k, v] of hits) if (v.length === 0 || t - v[v.length - 1] >= windowMs) hits.delete(k);
    for (const k of hits.keys()) {
      if (hits.size < maxKeys) break;
      hits.delete(k);
    }
  };
  return {
    take(key) {
      const t = now();
      const known = hits.get(key);
      if (!known && hits.size >= maxKeys) makeRoom(t);
      const recent = (known ?? []).filter((h) => t - h < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        const wait = Math.max(1, Math.ceil((recent[0] + windowMs - t) / 1000));
        throw new RateLimitedError(`Too many ${noun} (max ${max} per minute). Retry in ${wait}s.`, wait);
      }
      recent.push(t);
      hits.set(key, recent);
    },
  };
}

export interface AgentSaveInput {
  title: string;
  content?: string;
  type?: MemoryType;
  tags?: string[];
  collectionId?: string | null;
  metadata?: Metadata;
}

export interface AgentWriter {
  readonly actor: Actor;
  save(input: AgentSaveInput): Promise<Result<Memory>>;
  update(args: { id: string; patch: MemoryPatch }): Promise<Result<Memory>>;
  archive(args: { id: string }): Promise<Result<Memory>>;
  link(args: { fromId: string; toId: string; label: string }): Promise<Result<Relation>>;
}

export interface AgentWriterOptions {
  service: MemoryService;
  /** MCP clientInfo.name (cleaned); never taken from tool input. */
  clientName?: string | null;
  limiter?: RateLimiter;
  /** Rate-limit bucket (the HTTP layer uses one bucket per user, shared by all of that user's tokens). */
  limitKey?: string;
  maxPending?: number;
}

/**
 * The write surface exposed to MCP tools. It has no delete/approve/reject/restore/rollback/collection
 * methods, takes no actor/origin/provenance/source input, and every write lands as a pending proposal.
 */
export function createAgentWriter(opts: AgentWriterOptions): AgentWriter {
  const { service, limiter, limitKey = "mcp", maxPending = MAX_PENDING_AGENT_ITEMS } = opts;
  const actor = agentActor(opts.clientName);
  const gate = () => limiter?.take(limitKey);
  /** New work is refused when the inbox is full; refining a memory that already has a proposal is not new work. */
  const roomUnlessRefining = (s: WorkspaceState, memoryId: string) => {
    if (!Object.hasOwn(s.memories, memoryId) || !pendingRevisionFor(s, memoryId)) assertInboxHasRoom(s, maxPending);
  };

  return {
    actor,
    async save(input) {
      gate();
      // Fields are picked explicitly: source is fixed and provenance derives from the agent actor, so
      // extra keys on `input` (actor, provenance, source, id...) can never reach the domain.
      const { title, content, type, tags, collectionId, metadata } = input;
      return service.mutate((s, c) => {
        assertInboxHasRoom(s, maxPending);
        return createMemory(s, c, { title, content, type, tags, collectionId, metadata, source: "mcp", actor });
      });
    },
    async update({ id, patch }) {
      gate();
      const { title, content, type, tags, collectionId, metadata } = patch;
      return service.mutate((s, c) => {
        roomUnlessRefining(s, id);
        return updateMemory(s, c, { id, patch: { title, content, type, tags, collectionId, metadata }, actor });
      });
    },
    async archive({ id }) {
      gate();
      return service.mutate((s, c) => {
        roomUnlessRefining(s, id);
        return archiveMemory(s, c, { id, actor });
      });
    },
    async link({ fromId, toId, label }) {
      gate();
      return service.mutate((s, c) => {
        if (label.length > MAX_RELATION_LABEL) {
          throw new DomainError("too_large", `Label is too long (max ${MAX_RELATION_LABEL} characters)`);
        }
        assertInboxHasRoom(s, maxPending);
        return addRelation(s, c, {
          fromId,
          toId,
          label,
          actor,
          provenance: agentRelationProvenance(actor),
        });
      });
    },
  };
}
