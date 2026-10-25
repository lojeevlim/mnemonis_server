import {
  addRelation,
  approveAll,
  approveAllDetailed,
  approveRelation,
  approveRevision,
  archiveMemory,
  createCollection,
  createEmptyWorkspace,
  createMemory,
  deleteCollection,
  diffPending,
  diffRevisions,
  DomainError,
  getMemory,
  listMemories,
  listPendingRelations,
  listRelations,
  memoryHistory,
  pendingChanges,
  pendingCount,
  rejectAll,
  rejectAllDetailed,
  rejectRelation,
  rejectRevision,
  removeRelation,
  restoreMemory,
  rollbackMemory,
  searchWorkspace,
  timeline,
  updateCollection,
  updateMemory,
  SCHEMA_VERSION,
  type Actor,
  type ApproveAllResult,
  type BulkFilter,
  type Collection,
  type CreateMemoryInput,
  type DomainContext,
  type Memory,
  type MemoryDiff,
  type MemoryPatch,
  type Mutation,
  type PendingChange,
  type PendingRelation,
  type Relation,
  type RelationProvenance,
  type RejectAllResult,
  type Revision,
  type FieldChange,
  type SearchOptions,
  type SearchResult,
  type WorkspaceState,
} from "../domain/index.js";
import { agentRelationProvenance } from "./guards.js";
import type { Snapshot, UserStore, WorkspaceStore } from "../store/types.js";

export type Result<T> = Snapshot & { value: T };

/** Real clock + random ids (the domain itself stays deterministic). */
export function createSystemContext(): DomainContext {
  return {
    now: () => new Date().toISOString(),
    newId: (prefix) => `${prefix}_${globalThis.crypto.randomUUID().slice(0, 12)}`,
  };
}

export interface MemoryServiceOptions {
  store: UserStore;
  ctx?: DomainContext;
}

/**
 * The only thing REST and MCP call. Every mutation = one pure domain function applied to the latest
 * state inside the store's queue, persisted, rev++. The service trusts the `actor` it is given: the HTTP
 * layer passes the human user for REST, the MCP layer goes through guards.ts which forces an agent actor.
 */
export function createMemoryService({ store, ctx = createSystemContext() }: MemoryServiceOptions) {
  const mutate = <T>(fn: (s: WorkspaceState, c: DomainContext) => Mutation<T>): Promise<Result<T>> =>
    store.transact((s) => fn(s, ctx));
  const query = async <T>(fn: (s: WorkspaceState) => T): Promise<T> => fn((await store.read()).state);

  return {
    ctx,
    /** Generic serialized read-modify-write (used by guards for atomic check-then-write). */
    mutate,

    // ---- whole workspace ----
    getState: (): Promise<Snapshot> => store.read(),
    async exportJson(): Promise<string> {
      const { state } = await store.read();
      return JSON.stringify({ schemaVersion: SCHEMA_VERSION, state }, null, 2);
    },
    importJson: (json: string, opts: { ifMatchRev?: number } = {}): Promise<Snapshot> => store.replace(json, opts),
    reset: (): Promise<Snapshot> => store.write(createEmptyWorkspace()),

    // ---- memory writes ----
    createMemory: (input: CreateMemoryInput) => mutate((s, c) => createMemory(s, c, input)),
    updateMemory: (a: { id: string; patch: MemoryPatch; actor: Actor }) => mutate((s, c) => updateMemory(s, c, a)),
    archiveMemory: (a: { id: string; actor: Actor }) => mutate((s, c) => archiveMemory(s, c, a)),
    restoreMemory: (a: { id: string; actor: Actor }) => mutate((s, c) => restoreMemory(s, c, a)),
    rollbackMemory: (a: { memoryId: string; toRevisionId: string; actor: Actor }) =>
      mutate((s, c) => rollbackMemory(s, c, a)),

    // ---- relations ----
    addRelation: (a: {
      fromId: string;
      toId: string;
      label: string;
      actor: Actor;
      provenance?: RelationProvenance;
    }): Promise<Result<Relation>> =>
      mutate((s, c) => addRelation(s, c, { ...a, provenance: a.provenance ?? defaultProvenance(a.actor) })),
    removeRelation: (a: { id: string; actor: Actor }) => mutate((s, c) => removeRelation(s, a, c)),

    // ---- collections ----
    createCollection: (a: { name: string; description?: string }): Promise<Result<Collection>> =>
      mutate((s, c) => createCollection(s, c, a)),
    updateCollection: (a: { id: string; name?: string; description?: string }) =>
      mutate((s) => updateCollection(s, a)),
    deleteCollection: (a: { id: string }) => mutate((s) => deleteCollection(s, a)),

    // ---- review (the domain refuses non-user actors; guards.ts never exposes these) ----
    approveRevision: (a: { revisionId: string; actor: Actor }): Promise<Result<Revision>> =>
      mutate((s, c) => approveRevision(s, c, a)),
    rejectRevision: (a: { revisionId: string; actor: Actor }): Promise<Result<Revision>> =>
      mutate((s, c) => rejectRevision(s, c, a)),
    approveRelation: (a: { relationId: string; actor: Actor }): Promise<Result<Relation>> =>
      mutate((s, c) => approveRelation(s, c, a)),
    rejectRelation: (a: { relationId: string; actor: Actor }): Promise<Result<Relation>> =>
      mutate((s, c) => rejectRelation(s, c, a)),
    approveAll: (a: { actor: Actor } & BulkFilter): Promise<Result<string[]>> => mutate((s, c) => approveAll(s, c, a)),
    rejectAll: (a: { actor: Actor } & BulkFilter): Promise<Result<string[]>> => mutate((s, c) => rejectAll(s, c, a)),
    approveAllDetailed: (a: { actor: Actor } & BulkFilter): Promise<Result<ApproveAllResult>> =>
      mutate((s, c) => approveAllDetailed(s, c, a)),
    rejectAllDetailed: (a: { actor: Actor } & BulkFilter): Promise<Result<RejectAllResult>> =>
      mutate((s, c) => rejectAllDetailed(s, c, a)),

    // ---- queries (read the latest committed state) ----
    listMemories: (opts?: { includePending?: boolean }): Promise<Memory[]> => query((s) => listMemories(s, opts)),
    /** Throws DomainError "memory_not_found" for an unknown id. */
    getMemory: (id: string): Promise<Memory> =>
      query((s) => {
        const m = Object.hasOwn(s.memories, id) ? getMemory(s, id) : undefined;
        if (!m) throw new DomainError("memory_not_found", `Memory not found: ${id}`);
        return m;
      }),
    searchWorkspace: (opts?: SearchOptions): Promise<SearchResult> => query((s) => searchWorkspace(s, opts)),
    memoryHistory: (id: string, opts?: { includeUnsaved?: boolean }): Promise<Revision[]> =>
      query((s) => {
        if (!Object.hasOwn(s.memories, id)) throw new DomainError("memory_not_found", `Memory not found: ${id}`);
        return memoryHistory(s, id, opts);
      }),
    listRelations: (memoryId?: string, opts?: { includePending?: boolean }): Promise<Relation[]> =>
      query((s) => listRelations(s, memoryId, opts)),
    listCollections: (): Promise<Collection[]> => query((s) => Object.values(s.collections)),
    pendingChanges: (): Promise<PendingChange[]> => query(pendingChanges),
    pendingRelations: (): Promise<PendingRelation[]> => query(listPendingRelations),
    pendingCount: (): Promise<number> => query(pendingCount),
    timeline: (limit?: number): Promise<Revision[]> => query((s) => timeline(s, limit)),
    diffPending: (revisionId: string): Promise<MemoryDiff> => query((s) => diffPending(s, revisionId)),
    diffRevisions: (from: string, to: string): Promise<FieldChange[]> => query((s) => diffRevisions(s, from, to)),
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;

function defaultProvenance(actor: Actor): RelationProvenance {
  return actor.kind === "user"
    ? { origin: "user", createdBy: actor.name }
    : agentRelationProvenance(actor);
}

/** Per-user services over a multi-user store; each call builds a service bound to that user's workspace. */
export function createMemoryServices({ store, ctx = createSystemContext() }: { store: WorkspaceStore; ctx?: DomainContext }) {
  return { forUser: (userId: string): MemoryService => createMemoryService({ store: store.forUser(userId), ctx }) };
}

export type MemoryServices = ReturnType<typeof createMemoryServices>;
