/**
 * Message protocol between the main-thread proxy and the search-indexing
 * worker thread. The worker owns the SQLite database and all CPU-heavy work
 * (fingerprinting, search-document extraction, FTS5 write and query); the
 * main thread owns async persistence I/O, live-session snapshotting (which
 * require the Cordis `Context`), request normalization, filter validation,
 * cursor decoding, and result page assembly.
 */

import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'

/** Source-side identification for an observed session. */
export type SessionSource = 'persisted' | 'live'

/** One loaded session forwarded from the main thread to the worker for indexing. */
export interface LoadedSession {
  readonly sessionId: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
  readonly source: SessionSource
  /** Persistence revision for persisted-side indexing. */
  readonly revision?: string
  /** Whether a live-side row should carry `persisted = 1`. */
  readonly livePersisted?: boolean
}

/** A query the host asks the worker to execute. */
export interface WorkerQueryPayload {
  /** Response correlation id. */
  readonly queryId: number
  readonly scope: 'sessions' | 'events'
  /** LIMIT + 1 rows the worker should fetch. */
  readonly limit: number
  /** OFFSET within the matched result set. */
  readonly offset: number
  /** Whether persisted sources contribute rows. */
  readonly persistenceVisible: boolean
  /** Fingerprint of the normalized request (cursor sense). */
  readonly fingerprint: string
  /** Generation tag at the time of query (cursor sense). */
  readonly generation: string
  /** WHERE fragment built on host from normalized filters. */
  readonly whereSql: string
  /** Bindings for the host-built WHERE. */
  readonly bindings: readonly (string | number)[]
  /** Target session id for event-level queries, else undefined. */
  readonly sessionId?: SessionId
}

/** Per-entry revision that the host returns to the worker for incremental diffing. */
export interface IndexedRevision {
  readonly sessionId: SessionId
  readonly revision: string
  readonly source: SessionSource
}

/** Messages sent from the main thread to the worker thread. */
export type MainToWorkerMessage =
  | {
    readonly type: 'init'
    readonly path: string
    readonly journalMode: 'wal' | 'delete' | 'truncate' | 'persist'
  }
  | {
    readonly type: 'dispose'
  }
  | {
    /** Index a batch of freshly observed sessions and delete absent ones. */
    readonly type: 'reconcile'
    readonly loaded: readonly LoadedSession[]
    readonly indexedRevisions: readonly IndexedRevision[]
  }
  | {
    /** Execute a pre-validated search query. */
    readonly type: 'query'
    readonly payload: WorkerQueryPayload
  }

/** Messages sent from the worker thread to the main thread. */
export type WorkerToMainMessage =
  | {
    readonly type: 'ready'
    readonly generation: number
  }
  | {
    readonly type: 'reconciled'
    readonly generation: number
    readonly indexedIds: readonly SessionId[]
  }
  | {
    readonly type: 'queryResult'
    readonly queryId: number
    readonly rows: SearchRow[]
  }
  | {
    readonly type: 'error'
    readonly fatal: boolean
    readonly message: string
    readonly queryId?: number
  }

/** Raw row returned from a search-index query. */
export interface SearchRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
  generation: number
}
