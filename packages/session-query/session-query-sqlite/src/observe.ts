/** CPU-heavy session fingerprinting and search-document extraction. */

import { createHash } from 'node:crypto'
import { buildSessionEventSearchDocuments } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** Fingerprint + search documents derived from one session observation. */
export interface ObservedSessionData {
  /** SHA-256 of the cloned header, event count, and events (base64url). */
  readonly fingerprint: string
  /** Search-index documents built from the cloned events. */
  readonly documents: readonly SessionEventSearchDocument[]
}

// Forward declaration for the circular type reference.
import type { SessionEventSearchDocument } from '@deepseek-ai/dsh-session-query'

/**
 * Deep-clone the source data and compute a stable fingerprint plus search
 * documents. This is CPU-bound work that runs on the worker thread to keep
 * the host event loop responsive.
 * @param header - live or persisted session header.
 * @param inheritedEventCount - exact inherited event count paired with the header.
 * @param events - raw events; each is deep-cloned before processing.
 * @returns cloned-independent fingerprint and search documents.
 */
export function observeSessionData(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): ObservedSessionData {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, inheritedEventCount, events: detachedEvents }))
      .digest('base64url'),
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
  }
}
