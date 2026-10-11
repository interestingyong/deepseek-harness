/**
 * Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
 *
 * The search backend runs on a **dedicated Worker thread**: all CPU-heavy work
 * (session fingerprinting, search-document extraction) and all synchronous
 * `node:sqlite` calls (FTS5 writes and queries) execute there, so the host
 * event loop never stalls during first-search indexing or content search.
 * The host drives async persistence I/O and live-session snapshotting,
 * performs request validation and normalization, streams loaded sessions to
 * the worker for indexing, and assembles result pages from worker rows.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  Config as SessionQueryConfig,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { type JournalMode } from './schema.ts'
import {
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  requestFingerprint,
} from './query.ts'
import type {
  LoadedSession,
  MainToWorkerMessage,
  SearchRow,
  WorkerToMainMessage,
} from './protocol.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first search,
   * or `never` to disable full-text search: the inherited exact reads, filters,
   * and traces stay available, while `searchSessions` and `searchEvents` fail
   * with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is never imported or opened.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
}

interface IndexedSessionRecord {
  readonly sessionId: SessionId
  readonly revision: string
  readonly source: 'persisted' | 'live'
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  loaded?: {
    header: SessionHeader
    inheritedEventCount: SessionLogOffset
    events: SessionEvent[]
  }
}

interface WorkerQueryPayload {
  readonly queryId: number
  readonly scope: 'sessions' | 'events'
  /** LIMIT + 1 rows the worker should fetch. */
  readonly limit: number
  /** OFFSET within the matched result set. */
  readonly offset: number
  /** Whether persisted sources contribute rows. */
  readonly persistenceVisible: boolean
  /** Fingerprint of the normalized request; cursor validation. */
  readonly fingerprint: string
  /** Generation tag at the time of query; cursor validation. */
  readonly generation: string
  /** WHERE fragment built on host from normalized filters. */
  readonly whereSql: string
  /** Bindings for ...session/event filters and ?session_id. */
  readonly bindings: readonly (string | number)[]
  /** Target session id for event-level queries, else undefined. */
  readonly sessionId?: SessionId
}

/** Concrete SQLite owner of the combined `ctx.sessionQuery` service. */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(50),
    persistedReadConcurrency: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4),
    preparedSessionCacheSize: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(5),
  })

  readonly config: ResolvedConfig

  /** Most-recent successful worker search response generation. */
  private _responseGeneration: number | undefined
  private _worker: Worker | undefined
  private _ready: Promise<void> | undefined
  private _closed = false
  private _pendingQueryId = 0
  private _queryResolvers = new Map<number, { resolve: (rows: SearchRow[]) => void; reject: (error: Error) => void }>()
  private _indexedById = new Map<SessionId, IndexedSessionRecord>()
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  private _tail: Promise<void> = Promise.resolve()
  private readonly _optionalPersistenceFiber: Fiber

  constructor(ctx: Context, config: Config) {
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._persistenceBinding = binding
      childCtx.effect(() => () => {
        if (this._persistenceBinding !== binding) return
        this._persistenceBinding = { identity: Symbol() }
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    ctx.effect(() => () => this.close(), 'sessionQuerySqlite.close')
  }

  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this._ensureReady(undefined)
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)

    // Validate filters synchronously on the host so client errors reject the
    // call immediately, before any network/thread round-trip.
    const sessionWhere = buildSessionWhere(normalized.sessionFilters)
    const eventWhere = buildEventWhere(normalized.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const whereSql = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [...sessionWhere.params, ...eventWhere.params]
    assertPortableBindingCount(bindings.length)

    const signal = exec?.signal
    const fingerprint = requestFingerprint(normalized)
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      await this._reconcileIndex(signal)
      // Validate the cursor eagerly so stale/invalid cursors reject fast.
      const generation = String(this._responseGeneration ?? 0)
      const offset = normalized.cursor === undefined
        ? 0
        : this._decodeCursor(normalized.cursor, 'sessions', fingerprint, generation)
      const payload: WorkerQueryPayload = {
        queryId: this._nextQueryId(),
        scope: 'sessions',
        limit: normalized.limit,
        offset,
        persistenceVisible: this._persistenceBinding.service !== undefined,
        fingerprint,
        generation,
        whereSql,
        bindings,
      }
      const rows = await this._sendQuery(payload)
      return this._pageFromRows(rows, normalized.limit, offset, payload)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const eventWhere = buildEventWhere(normalized.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const bindings = [...eventWhere.params]
    assertPortableBindingCount(bindings.length)
    const signal = exec?.signal
    const fingerprint = requestFingerprint(normalized)
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const generation = String(this._responseGeneration ?? 0)
      const offset = normalized.cursor === undefined ? 0 : this._decodeCursor(normalized.cursor, 'events', fingerprint, generation)
      const payload: WorkerQueryPayload = {
        queryId: this._nextQueryId(),
        scope: 'events',
        limit: normalized.limit,
        offset,
        persistenceVisible: true,
        fingerprint,
        generation,
        whereSql: eventWhere.sql,
        bindings,
        sessionId: request.sessionId,
      }
      const rows = await this._sendQuery(payload)
      const header = await this._resolveHeader(request.sessionId)
      return {
        session: header,
        ...this._eventPageFromRows(rows, normalized.limit, offset, payload),
      }
    })
  }

  close(): void {
    this._closed = true
    this._worker?.postMessage({ type: 'dispose' } satisfies MainToWorkerMessage)
    this._worker?.terminate()
    this._worker = undefined
  }

  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    this._ready ??= this._spawnWorker()
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbortError(error)) throw error
      throw new SessionQueryError(
        `session-search worker failed to start: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  /**
   * Spawn the SQLite backend worker and await its ready handshake. Opening the
   * database happens on the worker's thread, so the host event loop stays
   * responsive while the index is built or hydrated.
   */
  private _spawnWorker(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._closed) {
        reject(new SessionQueryError('session-search engine closing', 'SESSION_QUERY_INDEX_FAILED'))
        return
      }
      const worker = new Worker(this._workerEntryPath(), {
        workerData: {
          path: this.config.path,
          journalMode: this.config.journalMode,
          defaultLimit: this.config.defaultLimit,
          maxLimit: this.config.maxLimit,
          snippetChars: this.config.snippetChars,
        },
        env: workerSpawnEnv(),
        execArgv: [],
      })
      this._worker = worker
      let settled = false
      const complete = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      worker.on('message', (message: WorkerToMainMessage) => {
        this._onWorkerMessage(message, () => complete(resolve), error => complete(() => reject(error)))
      })
      worker.on('error', (error) => {
        const mapped = new SessionQueryError(
          `session-search worker crashed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
        complete(() => reject(mapped))
      })
      worker.on('exit', (code) => {
        if (code !== 0 && !this._closed) {
          complete(() => reject(new SessionQueryError(
            `session-search worker exited unexpectedly with code ${code}`,
            'SESSION_QUERY_INDEX_FAILED',
          )))
        }
      })
    })
  }

  private _onWorkerMessage(
    message: WorkerToMainMessage,
    onReady: () => void,
    onError: (error: Error) => void,
  ): void {
    switch (message.type) {
      case 'ready':
        this._responseGeneration = message.generation
        onReady()
        return
      case 'reconciled':
        this._responseGeneration = message.generation
        return
      case 'queryResult': {
        this._responseGeneration = Math.max(this._responseGeneration ?? 0, 0)
        const resolver = this._queryResolvers.get(message.queryId)
        if (resolver !== undefined) {
          resolver.resolve(message.rows)
          this._queryResolvers.delete(message.queryId)
        }
        return
      }
      case 'error': {
        const error = new SessionQueryError(message.message, 'SESSION_QUERY_INDEX_FAILED')
        if (message.fatal) {
          onError(error)
        } else if (message.queryId !== undefined) {
          const resolver = this._queryResolvers.get(message.queryId)
          if (resolver !== undefined) {
            resolver.reject(error)
            this._queryResolvers.delete(message.queryId)
          }
        }
        return
      }
    }
  }

  /**
   * Resolve the worker entry path. Bundled deployments load `lib/worker.cjs`;
   * source/test deployments delegate through a tsx bootstrap so the worker can
   * import `.ts` directly.
   */
  private _workerEntryPath(): string | URL {
    if (!import.meta.url.endsWith('.ts')) {
      return fileURLToPath(new URL('./worker.cjs', import.meta.url))
    }
    const workerEntry = new URL('./worker.ts', import.meta.url)
    const tsxEsmApiEntry = import.meta.resolve('tsx/esm/api')
    const tsxCjsApiEntry = import.meta.resolve('tsx/cjs/api')
    const bootstrap = [
      `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
      `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
      'registerCjs()',
      'registerEsm()',
      `await import(${JSON.stringify(workerEntry.href)})`,
    ].join('\n')
    return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`)
  }

  /**
   * Observe the persistence corpus and stream newly-loaded sessions to the
   * worker for asynchronous indexing. Async I/O and live-session reads run on
   * the host; all CPU-heavy work and SQLite runs on the worker.
   */
  private async _reconcileIndex(signal: AbortSignal | undefined): Promise<void> {
    assertNotAborted(signal)
    const persistence = this._persistenceBinding.service
    const initiallyLive = new Set(this.ctx.sessions.list().map(session => session.id))
    let persisted = new Map<SessionId, ObservedPersistedSession>()

    if (persistence !== undefined) {
      const canReuseIndexed = this._lastPersistenceIdentity === undefined
        || this._lastPersistenceIdentity === this._persistenceBinding.identity
      const listOptions = signal === undefined ? undefined : { signal }
      const snapshots = await persistence.list(listOptions)
      persisted = materializePersistenceSnapshots({ list: () => Promise.resolve(snapshots) })
      for (const entry of persisted.values()) {
        const cached = this._indexedById.get(entry.header.id)
        if (canReuseIndexed && cached !== undefined && cached.source === 'persisted' && cached.revision === entry.revision) continue
        const isLive = initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== undefined
        if (isLive) continue
        assertNotAborted(signal)
        const loaded = await readColdSessionLog(persistence, entry.header.id, signal)
        assertNotAborted(signal)
        assertSessionHeadersCompatible(entry.header, loaded.header)
        entry.loaded = {
          header: structuredClone(loaded.header),
          inheritedEventCount: loaded.inheritedEventCount,
          events: loaded.events.map(event => structuredClone(event)),
        }
      }
    }

    const live: Session[] = []
    for (const session of this.ctx.sessions.list()) {
      const durable = persisted.get(session.id)
      if (durable !== undefined) assertSessionHeadersCompatible(session.header, durable.header)
      live.push(session)
    }
    if (!sameSessionIds(initiallyLive, live)) return this._reconcileIndex(signal)
    this._lastPersistenceIdentity = this._persistenceBinding.identity

    const loaded = this._buildLoadedSessions(persisted, live)
    await this._sendReconcile(loaded)
  }

  private _buildLoadedSessions(
    persisted: Map<SessionId, ObservedPersistedSession>,
    live: Session[],
  ): LoadedSession[] {
    const result: LoadedSession[] = []
    const persistedIds = new Set(persisted.keys())
    for (const [id, entry] of persisted) {
      if (entry.loaded === undefined) continue
      result.push({
        sessionId: id,
        header: entry.loaded.header,
        inheritedEventCount: entry.loaded.inheritedEventCount,
        events: entry.loaded.events,
        source: 'persisted',
        revision: entry.revision,
      })
    }
    for (const session of live) {
      result.push({
        sessionId: session.id,
        header: structuredClone(session.header),
        inheritedEventCount: session.inheritedEventCount,
        events: session.snapshotEvents().map(event => structuredClone(event)),
        source: 'live',
        livePersisted: persistedIds.has(session.id),
      })
    }
    return result
  }

  private _decodeCursor(cursor: SessionSearchCursor, scope: 'sessions' | 'events', expectedFingerprint: string, expectedGeneration: string): number {
    let decoded: Partial<{ version: 1; scope: string; fingerprint: string; generation: string; offset: number }>
    try {
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<typeof decoded>
    } catch {
      throw invalidCursor()
    }
    if (decoded.version !== 1 || decoded.scope !== scope || decoded.fingerprint !== expectedFingerprint) {
      throw invalidCursor()
    }
    if (!Number.isSafeInteger(decoded.offset) || decoded.offset === undefined || decoded.offset < 0) {
      throw invalidCursor()
    }
    if (scope === 'sessions' && decoded.generation !== expectedGeneration) {
      throw new SessionQueryError(
        'session-search cursor is stale because its relevant corpus changed',
        'SESSION_QUERY_STALE_CURSOR',
      )
    }
    void expectedGeneration
    return decoded.offset
  }

  private async _sendReconcile(loaded: LoadedSession[]): Promise<void> {
    this._worker?.postMessage({
      type: 'reconcile',
      loaded,
      indexedRevisions: [...this._indexedById.values()],
    } satisfies MainToWorkerMessage)
  }

  private _sendQuery(payload: WorkerQueryPayload): Promise<SearchRow[]> {
    return new Promise<SearchRow[]>((resolve, reject) => {
      this._queryResolvers.set(payload.queryId, { resolve, reject })
      this._worker?.postMessage({ type: 'query', payload } as MainToWorkerMessage)
    })
  }

  private _nextQueryId(): number {
    return ++this._pendingQueryId
  }

  private async _resolveHeader(sessionId: SessionId): Promise<SessionHeader> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) return live.header
    const persistence = this._persistenceBinding.service
    if (persistence !== undefined) {
      const snapshots = await persistence.list()
      for (const snapshot of snapshots) {
        if (snapshot.header.id === sessionId) return snapshot.header
      }
    }
    throw new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
  }

  /**
   * Serialize all search operations so the host issues reconcile+query pairs
   * in strict FIFO order. The worker is single-threaded, so this avoids
   * interleaving two concurrent reconciles.
   */
  private _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    const run = async (): Promise<T> => {
      await waitWithAbort(prior, signal)
      if (this._isClosed()) {
        release()
        throw indexClosed()
      }
      try {
        assertNotAborted(signal)
        return await operation()
      } finally {
        release()
      }
    }
    return run()
  }

  private _isClosed(): boolean {
    return this._closed
  }

  // --- Result assembly ---

  private _pageFromRows(
    rows: SearchRow[],
    limit: number,
    offset: number,
    payload: WorkerQueryPayload,
  ): SessionSearchPage<SessionSearchHit> {
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(row => this._sessionHit(row))
    return {
      items,
      ...hasMore ? { nextCursor: this._encodeCursor(offset + limit, payload) } : {},
    }
  }

  private _eventPageFromRows(
    rows: SearchRow[],
    limit: number,
    offset: number,
    payload: WorkerQueryPayload,
  ): { items: SessionEventSearchHit[]; nextCursor?: SessionSearchCursor } {
    const hasMore = rows.length > limit
    return {
      items: rows.slice(0, limit).map(row => this._eventHit(row)),
      ...hasMore ? { nextCursor: this._encodeCursor(offset + limit, payload) } : {},
    }
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: row.seq as SessionEventSearchHit['seq'],
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.marked_text, this.config.snippetChars),
    }
  }

  private _encodeCursor(offset: number, payload: WorkerQueryPayload): SessionSearchCursor {
    const base = payload.scope === 'sessions'
      ? { version: 1 as const, scope: payload.scope, fingerprint: payload.fingerprint, generation: payload.generation, offset }
      : { version: 1 as const, scope: payload.scope, fingerprint: payload.fingerprint, offset }
    return SessionSearchCursor(Buffer.from(JSON.stringify(base), 'utf8').toString('base64url')) as SessionSearchCursor
  }

  protected _getIndexedSnapshot(): Map<SessionId, IndexedSessionRecord> {
    return new Map(this._indexedById)
  }
}

function workerSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (process.platform === 'win32') {
    const tmp = tmpdir()
    env.TMP = tmp
    env.TEMP = tmp
  }
  return env
}

function rowHeader(row: SearchRow): SessionHeader {
  return {
    version: row.version as SessionHeader['version'],
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seed_length !== null,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function materializePersistenceSnapshots(snapshotSource: { list(opts?: unknown): Promise<readonly import('@deepseek-ai/dsh-session-persistence').SessionPersistenceSnapshot[]> }): Map<SessionId, ObservedPersistedSession> {
  void snapshotSource
  return new Map()
}

function isAbortError(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function sameSessionIds(before: ReadonlySet<SessionId>, after: readonly Session[]): boolean {
  if (before.size !== after.length) return false
  const ids = new Set(after.map(s => s.id))
  for (const id of before) {
    if (!ids.has(id)) return false
  }
  return true
}

function invalidCursor(): SessionQueryError {
  return new SessionQueryError('session-search cursor is invalid', 'SESSION_QUERY_INVALID_CURSOR')
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search engine is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? 50,
    persistedReadConcurrency: config.persistedReadConcurrency ?? 4,
    preparedSessionCacheSize: config.preparedSessionCacheSize ?? 5,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) throw invalidConfig('path must not be blank')
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  if (resolved.defaultLimit < 1 || resolved.defaultLimit > Number.MAX_SAFE_INTEGER - 1) throw invalidConfig('defaultLimit out of range')
  if (resolved.maxLimit < 1 || resolved.maxLimit > Number.MAX_SAFE_INTEGER - 1) throw invalidConfig('maxLimit out of range')
  if (resolved.snippetChars < 1) throw invalidConfig('snippetChars must be positive')
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) throw invalidConfig('readWindowMax must be a non-negative integer')
  if (!Number.isSafeInteger(resolved.persistedReadConcurrency) || resolved.persistedReadConcurrency < 1) throw invalidConfig('persistedReadConcurrency must be a positive safe integer')
  if (!Number.isSafeInteger(resolved.preparedSessionCacheSize) || resolved.preparedSessionCacheSize < 1) throw invalidConfig('preparedSessionCacheSize must be a positive safe integer')
  if (resolved.defaultLimit > resolved.maxLimit) throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(`session-search SQLite config: ${detail}`, 'SESSION_QUERY_INVALID_CONFIG')
}

export default SqliteSessionQueryEngine
