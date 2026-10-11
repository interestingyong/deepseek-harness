// @vitest-environment jsdom
/**
 * PgUp/PgDn draft recall: the SessionInputShell walk over the bound
 * Conversation-store history — walk/pin/restore semantics, submission-time
 * append and cursor reset, and the store's dedup/limit write policy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { createConversationStore } from '../src/client/stores.ts'

const SCTX = {} as Context

function bench() {
  const sink = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
  const shell = new SessionInputShell({
    actx: SCTX,
    defaultSink: sink,
    commandAttachments: {
      serialize: () => Promise.resolve([]),
      release: () => {},
      unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported`,
    },
  })
  const store = createConversationStore().create(`recall-${Math.random()}`)
  shell.bindHistory(
    () => store.getSnapshot().history ?? [],
    (text) => { store.actions.pushHistory(text) },
  )
  return { shell, store, sink }
}

describe('draft recall history', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('records non-blank submissions in order and skips whitespace-only drafts', () => {
    const { shell, store } = bench()
    shell.setDraft('first')
    shell.submit()
    shell.setDraft('   ')
    shell.submit()
    shell.setDraft('second')
    shell.submit()
    expect(store.getSnapshot().history).toEqual(['first', 'second'])
    // Enter with an empty draft records nothing either.
    shell.submit()
    expect(store.getSnapshot().history).toEqual(['first', 'second'])
  })

  it('collapses consecutive duplicate submissions', () => {
    const { shell, store } = bench()
    shell.setDraft('again')
    shell.submit()
    shell.setDraft('again')
    shell.submit()
    expect(store.getSnapshot().history).toEqual(['again'])
  })

  it('walks older, pins at the oldest, and restores the stashed live draft past the newest', () => {
    const { shell } = bench()
    shell.setDraft('one')
    shell.submit()
    shell.setDraft('two')
    shell.submit()

    shell.setDraft('live')
    expect(shell.recall('newer')).toBe(false) // nothing newer than the live draft
    expect(shell.snapshot.draft).toBe('live')

    expect(shell.recall('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('two')
    expect(shell.recall('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('one')
    expect(shell.recall('older')).toBe(true) // pinned at the oldest entry
    expect(shell.snapshot.draft).toBe('one')

    expect(shell.recall('newer')).toBe(true)
    expect(shell.snapshot.draft).toBe('two')
    expect(shell.recall('newer')).toBe(true)
    expect(shell.snapshot.draft).toBe('live') // the pre-walk draft returns
    expect(shell.recall('newer')).toBe(false) // back at the live draft
  })

  it('recalls an edited walk entry without touching the stash', () => {
    const { shell } = bench()
    shell.setDraft('sent')
    shell.submit()
    shell.setDraft('work in progress')
    shell.recall('older')
    shell.setDraft('reworked')
    expect(shell.recall('newer')).toBe(true)
    expect(shell.snapshot.draft).toBe('work in progress')
  })

  it('refuses recalls without a history and after unbinding', () => {
    const sink = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
    const shell = new SessionInputShell({
      actx: SCTX,
      defaultSink: sink,
      commandAttachments: {
        serialize: () => Promise.resolve([]),
        release: () => {},
        unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported`,
      },
    })
    expect(shell.recall('older')).toBe(false)
    const history = ['sent']
    const unbind = shell.bindHistory(() => history, () => {})
    expect(shell.recall('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('sent')
    shell.recall('newer')
    unbind()
    expect(shell.recall('older')).toBe(false)
  })

  it('a submission during a walk resets the cursor to the live draft', () => {
    const { shell, store } = bench()
    shell.setDraft('older-message')
    shell.submit()
    shell.setDraft('next-message')
    shell.submit()

    shell.recall('older') // walk in
    expect(shell.snapshot.draft).toBe('next-message')
    shell.submit() // resend the recalled tail: a consecutive duplicate, collapsed
    expect(store.getSnapshot().history).toEqual(['older-message', 'next-message'])
    // The walk is over: PageDown falls through, and the next PageUp starts
    // from the tail (the just-recorded entry).
    expect(shell.recall('newer')).toBe(false)
    expect(shell.recall('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('next-message')
    expect(shell.recall('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('older-message')
  })

  it('bounds the recall list to the recent tail', () => {
    const store = createConversationStore().create(`recall-cap-${Math.random()}`)
    for (let i = 0; i < 205; i += 1) store.actions.pushHistory(`m${i}`)
    const history = store.getSnapshot().history ?? []
    expect(history).toHaveLength(200)
    expect(history[0]).toBe('m5')
    expect(history.at(-1)).toBe('m204')
  })
})
