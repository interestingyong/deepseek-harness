/**
 * Worker-thread backend for session full-text search.
 *
 * Owns the SQLite `DatabaseSync` handle and every CPU-bound operation
 * (fingerprinting, search-document extraction, FTS5 write and query) so
 * the host event loop stays responsive for UI RPC and session I/O. The
 * host (`SqliteSessionQueryEngine`) drives asynchronous persistence I/O
 * and live-session snapshots, forwards loaded sessions for indexing, and
 * sends pre-validated search queries; the worker executes FTS5 and
 * streams result rows back.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite/worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import type { DatabaseSync } from 'node:sqlite'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { openSearchDatabase, type JournalMode } from './schema.ts'
import {
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  assertPortableBindingCount,
} from './query.ts'
import { observeSessionData } from './observe.ts'
import type {
  IndexedRevision,
  LoadedSession,
  MainToWorkerMessage,
  SearchRow,
  SessionSource,
  WorkerQueryPayload,
  WorkerToMainMessage,
} from './protocol.ts'

/** Worker initialization passed via `workerData`. */
interface WorkerInit {
  path: string
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
}

/** Bytelength of the highlight-start marker, precomputed for match-count math. */
const HIGHLIGHT_START_BYTES = Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8')

/** A search-index document derived from a single session event. */
interface WriteDocument {
  text: string
  sessionId: SessionId
  seq: number
  type: string
  time: number
  surface: string
}

const init = workerData as WorkerInit
const port = parentPort
if (port === null) throw new Error('session-query-sqlite worker requires a parent port')

let db: DatabaseSync | undefined
let globalGeneration = 0
const indexedById = new Map<SessionId, IndexedRevision>()

void main()

/** Open the SQLite handle, then start processing host messages. */
async function main(): Promise<void> {
  try {
    db = await openSearchDatabase(init.path, init.journalMode)
    const state = db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1')
      .get() as { global_generation: number }
    globalGeneration = state.global_generation
    await hydrateIndexedSnapshot()
    post({ type: 'ready', generation: globalGeneration })
  } catch (error: unknown) {
    post({
      type: 'error',
      fatal: true,
      message: `session-query worker failed to open SQLite: ${errorMessage(error)}`,
    })
    return
  }
  port?.on('message', (message: MainToWorkerMessage) => {
    onMessage(message)
  })
}

/** Rebuild the in-memory indexed snapshot from persistent tables. */
// oxlint-disable-next-line require-await -- SQLiteDriver calls are synchronous; kept async for interface parity.
async function hydrateIndexedSnapshot(): Promise<void> {
  if (db === undefined) return
  indexedById.clear()
  for (const row of db.prepare('SELECT id, revision FROM persisted_sessions').all() as Array<{ id: string; revision: string }>) {
    indexedById.set(row.id as SessionId, { sessionId: row.id as SessionId, revision: row.revision, source: 'persisted' })
  }
  for (const row of db.prepare('SELECT id, fingerprint FROM temp.live_sessions').all() as Array<{ id: string; fingerprint: string }>) {
    indexedById.set(row.id as SessionId, { sessionId: row.id as SessionId, revision: `live:${row.fingerprint}`, source: 'live' })
  }
}

function onMessage(message: MainToWorkerMessage): void {
  try {
    switch (message.type) {
      case 'init': break
      case 'dispose':
        dispose()
        return
      case 'reconcile':
        void handleReconcile(message.loaded)
        return
      case 'query':
        handleQuery(message.payload)
        return
    }
  } catch (error: unknown) {
    const queryId = (message as { payload?: { queryId?: number } }).payload?.queryId
    if (queryId !== undefined) {
      post({ type: 'error', fatal: false, message: `session-query query execution failed: ${errorMessage(error)}`, queryId })
    } else {
      post({ type: 'error', fatal: false, message: errorMessage(error) })
    }
  }
}

// oxlint-disable-next-line require-await -- synchronous SQLite writes; async for fire-and-forget caller ergonomics.
async function handleReconcile(loaded: readonly LoadedSession[]): Promise<void> {
  if (db === undefined) throw new SessionQueryError('worker SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
  const loadedIds = new Set<SessionId>()
  let changed = false

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const session of loaded) {
      const key = session.source === 'persisted' ? (session.revision ?? '') : `live:${session.sessionId}`
      const existing = indexedById.get(session.sessionId)
      if (existing !== undefined && existing.source === session.source && existing.revision === key) continue
      writeSession(session)
      loadedIds.add(session.sessionId)
      changed = true
    }
    for (const [id, meta] of indexedById) {
      if (loadedIds.has(id)) continue
      deleteSession(id, meta)
      indexedById.delete(id)
      changed = true
    }
    if (changed) {
      globalGeneration += 1
      db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(globalGeneration)
    }
    db.exec('COMMIT')
  } catch (error: unknown) {
    try { db.exec('ROLLBACK') } catch { /* ROLLBACK failure keeps original cause */ }
    throw error
  }
  post({ type: 'reconciled', generation: globalGeneration, indexedIds: [...loadedIds] })
}

function writeSession(session: LoadedSession): void {
  if (db === undefined) return
  const { fingerprint, documents } = observeSessionData(session.header, session.inheritedEventCount, session.events)
  deleteFromSource(session.sessionId, session.source)
  if (session.source === 'persisted') {
    writePersisted(session, documents, session.revision ?? '')
  } else {
    writeLive(session, fingerprint, documents, session.livePersisted ?? false)
  }
  const revision = session.source === 'persisted' ? (session.revision ?? '') : `live:${fingerprint}`
  indexedById.set(session.sessionId, { sessionId: session.sessionId, revision, source: session.source })
}

function writePersisted(
  session: LoadedSession,
  documents: readonly WriteDocument[],
  revision: string,
): void {
  if (db === undefined) return
  db.prepare(`
    INSERT INTO persisted_sessions
      (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...headerBindings(session.header, session.inheritedEventCount), revision, globalGeneration)
  const insert = db.prepare(`
    INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const document of documents) {
    const text = sanitize(document.text)
    insert.run(text, document.sessionId, document.seq, document.type, document.time, document.surface, Array.from(text).length)
  }
}

function writeLive(
  session: LoadedSession,
  fingerprint: string,
  documents: readonly WriteDocument[],
  persisted: boolean,
): void {
  if (db === undefined) return
  db.prepare(`
    INSERT INTO temp.live_sessions
      (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...headerBindings(session.header, session.inheritedEventCount), fingerprint, persisted ? 1 : 0, globalGeneration)
  const insert = db.prepare(`
    INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const document of documents) {
    const text = sanitize(document.text)
    insert.run(text, document.sessionId, document.seq, document.type, document.time, document.surface, Array.from(text).length)
  }
}

function deleteFromSource(id: SessionId, source: SessionSource): void {
  if (db === undefined) return
  if (source === 'persisted') {
    db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
  } else {
    db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
  }
}

function deleteSession(id: SessionId, meta: IndexedRevision): void {
  void meta
  deleteFromSource(id, 'persisted')
  deleteFromSource(id, 'live')
}

/** Execute a pre-validated FTS5 query on the worker thread. */
function handleQuery(payload: WorkerQueryPayload): void {
  if (db === undefined) {
    post({ type: 'error', fatal: false, message: 'worker SQLite index is closed', queryId: payload.queryId })
    return
  }
  const bindings = [...selectedDocumentsParams(payload), ...payload.bindings, payload.limit + 1, payload.offset]
  let sql: string
  if (payload.scope === 'sessions') {
    sql = `
      ${selectedDocumentsSql()},
      filtered AS (
        SELECT * FROM matched ${payload.whereSql.length === 0 ? '' : `WHERE ${payload.whereSql}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `
    assertPortableBindingCount(bindings.length)
  } else {
    sql = `
      ${selectedDocumentsSql()}
      SELECT * FROM matched
      WHERE ${['session_id = ?', payload.whereSql].filter(Boolean).join(' AND ')}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `
    assertPortableBindingCount(bindings.length)
  }
  const rows = db.prepare(sql).all(...bindings) as unknown as SearchRow[]
  post({ type: 'queryResult', queryId: payload.queryId, rows })
}

function dispose(): void {
  db?.close()
  db = undefined
  port?.removeAllListeners('message')
  port?.close()
}

function post(message: WorkerToMainMessage): void {
  port?.postMessage(message)
}

// --- SQL fragment builders (mirror helpers in the host implementation) ---

function selectedDocumentsSql(): string {
  return `WITH candidates AS (
    SELECT
      pd.session_id AS session_id,
      ps.version AS version,
      ps.created_at AS created_at,
      ps.cwd AS cwd,
      ps.parent_session AS parent_session,
      ps.seed_length AS seed_length,
      ps.delegation_depth AS delegation_depth,
      ps.agent_preset AS agent_preset,
      0 AS live,
      1 AS persisted,
      CAST(pd.seq AS INTEGER) AS seq,
      pd.type AS type,
      CAST(pd.time AS INTEGER) AS time,
      pd.surface AS surface,
      highlight(persisted_docs, 0, ?, ?) AS marked_text,
      CAST(pd.codepoint_length AS INTEGER) AS document_length
    FROM persisted_docs AS pd
    JOIN persisted_sessions AS ps ON ps.id = pd.session_id
    WHERE persisted_docs MATCH ?
      AND ? = 1
      AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
    UNION ALL
    SELECT
      ld.session_id AS session_id,
      ls.version AS version,
      ls.created_at AS created_at,
      ls.cwd AS cwd,
      ls.parent_session AS parent_session,
      ls.seed_length AS seed_length,
      ls.delegation_depth AS delegation_depth,
      ls.agent_preset AS agent_preset,
      1 AS live,
      CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
      CAST(ld.seq AS INTEGER) AS seq,
      ld.type AS type,
      CAST(ld.time AS INTEGER) AS time,
      ld.surface AS surface,
      highlight(live_docs, 0, ?, ?) AS marked_text,
      CAST(ld.codepoint_length AS INTEGER) AS document_length
    FROM temp.live_docs AS ld
    JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
    WHERE live_docs MATCH ?
  ), matched AS (
    SELECT *,
      (length(CAST(marked_text AS BLOB)) - length(CAST(replace(marked_text, ?, '') AS BLOB))) / ? AS match_count
    FROM candidates
  )`
}

function selectedDocumentsParams(payload: WorkerQueryPayload): Array<string | number> {
  const expression = quoteFtsData(payload.fingerprint)
  const visible = payload.persistenceVisible ? 1 : 0
  return [
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    visible,
    visible,
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    FTS_HIGHLIGHT_START,
    HIGHLIGHT_START_BYTES,
  ]
}

function quoteFtsData(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

function sanitize(text: string): string {
  return text.replaceAll(' ', '�').replaceAll(FTS_HIGHLIGHT_START, '�').replaceAll(FTS_HIGHLIGHT_END, '�')
}

function headerBindings(header: SessionHeader, inheritedEventCount: SessionLogOffset): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded ? inheritedEventCount : null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

export type { SearchRow }
