/**
 * Canonical selection of a child's final assistant output. Backend run results
 * and `subagent/end.lastAssistantMessage` apply the same rule: prefer the last
 * assistant message carrying visible prose (a non-blank `text` block); a
 * textless but non-empty message (reasoning- or tool-call-only) remains the
 * candidate only when no textful message exists, so a final bare tool call no
 * longer blanks an answer the child spoke one message earlier. An
 * empty-content message records usage only when the loop appends it after a
 * max-tokens step with no executable blocks, so it does not replace earlier
 * output. If no non-empty message exists at all, select the accumulated
 * assistant text. Selection is independent of the run's stop reason.
 *
 * @module @deepseek-ai/dsh-subagent/assistant-output
 */

import { joinAssistantStreamText, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Incremental fold of the selection rule, for backends that observe a child's
 * output as it streams: session-event backends {@link push} each event, and
 * transports without session events (ACP content chunks) {@link pushText} raw
 * text into the same streamed fallback.
 */
export class AssistantOutputFold {
  /**
   * Last assistant message carrying visible prose (a non-blank `text` block).
   * Preferred over {@link messageAny}: a trailing tool-call-only message
   * (a bare `send_message`-style invocation) must not blank the answer the
   * child spoke one message earlier — settlement renders prose, not tool
   * calls, so the tool-only choice surfaces as an empty closing message.
   */
  private messageTextful: ContentBlock[] | undefined
  /**
   * Last non-empty assistant message whatever its blocks. Fallback for runs
   * whose only output is textless content (reasoning- or tool-call-only), so
   * their final message still reports instead of dropping to stream text.
   */
  private messageAny: ContentBlock[] | undefined
  private partial: string[] = []

  /**
   * Fold one session event: a non-empty assistant message becomes the
   * candidate final answer — the newest one with visible prose always wins,
   * the newest non-empty one otherwise — while its embedded stream and any
   * log-only attempt extend the streamed fallback; every other event
   * contributes nothing.
   * @param event - the next observed session event.
   */
  push(event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      if (content.length > 0) {
        this.messageAny = content
        if (content.some(hasVisibleText)) this.messageTextful = content
      }
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      this.pushText(joinAssistantStreamText(event.data.stream))
    }
  }

  /**
   * Extend the streamed fallback with text observed outside session events.
   * @param text - the next streamed text piece (an empty piece is a no-op).
   */
  pushText(text: string): void {
    if (text.length > 0) this.partial.push(text)
  }

  /**
   * Select the final output folded so far.
   * @returns the last assistant message carrying visible prose, else the last
   *   non-empty message, else the accumulated streamed text, or `undefined`
   *   when the child produced none of the three.
   */
  collect(): ContentBlock[] | undefined {
    if (this.messageTextful !== undefined) return this.messageTextful
    if (this.messageAny !== undefined) return this.messageAny
    const text = this.partial.join('')
    return text.length > 0 ? [{ type: 'text', text }] : undefined
  }
}

/**
 * True when one block renders as readable closing prose: a `text` block with
 * non-blank content. Reasoning blocks are model thinking rather than spoken
 * output, and tool calls carry no displayable prose, so neither qualifies.
 * @param block - the content block to test.
 */
function hasVisibleText(block: ContentBlock): boolean {
  return block.type === 'text' && block.text.trim().length > 0
}

/**
 * Apply the selection rule to one complete child-owned event suffix.
 * @param events - the child-owned events (after any seed or epoch boundary).
 * @returns the selected output, or `undefined` when the child produced none.
 */
export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined {
  // TODO: this folds the complete suffix once per run/epoch settlement. If a
  // long continuable epoch ever profiles hot here, scan backward with early
  // exit for the last non-empty message and fold text deltas only on the
  // no-message fallback.
  const fold = new AssistantOutputFold()
  for (const event of events) fold.push(event)
  return fold.collect()
}
