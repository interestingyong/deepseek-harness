# Agent Note: Composer PageUp/PageDown draft recall

Status: implemented

English | [中文](2026-09-11-composer-pgup-pgdn-draft-recall.zh.md)

## Problem

The Web composer's draft was write-once: a sent message had to be retyped (or tediously copied from the transcript) to iterate on it, and there was no way to revisit earlier prompts of the same session. Terminal agents such as Codex solve this with an input-history walk; the Web UI needed the equivalent gesture without stealing keys the completion menu or the editable already owns.

## Decision

**Walking the session's submitted drafts is bound to two gestures: PageUp/PageDown and Arrow Up/Down.** Both walk 'older' back and 'newer' forward, following the Shell-history convention: the first 'older' step stashes the live draft, the oldest entry pins (further 'older' steps stay consumed so the editable does not jump-scroll), and the step past the newest entry restores the stash. The walk state lives on the `SessionInputShell` ([facade.ts](../../../../packages/client/ui-conversation/src/client/input/facade.ts)) as package-private cursor + stash, and `recall(direction)` joins the `ComposerKeyboard` face so the bar can gate it like every other gesture.

**PageUp/PageDown ride a plain keydown listener on the composer root** — Lexical exposes no command for them — so conversation scrolling outside the composer is untouched, modifier chords stay native, IME composition suppresses the walk, and a refused recall (no history, busy adjudicating/submitting phase, open completion menu) falls through to the native capped-editable scroll.

**Arrow Up/Down reach recall through Lexical's `KEY_ARROW_*_COMMAND` at CRITICAL priority, but only where the caret sits on the document's top/bottom line** ([keymap.ts](../../../../packages/client/ui-conversation/src/client/input/editor/keymap.ts), `caretAtVerticalBoundary`), so the arrows still move the caret between lines in a multi-line draft. A single-line composer short-circuits to always-recall — shell-prompt semantics, the Codex TUI gesture users reach for first — because there is no second line for the arrows to traverse. Boundary detection reads the committed editor state (not a fresh update: the command handler already runs inside Lexical's keydown dispatch, where `editor.read` would start a nested update and throw), so the caret is still at its pre-move position. The completion-menu arbitration runs first, so an open menu keeps the arrows for its own traversal.

**The list itself is the per-Session Conversation store's `history` key** ([stores.ts](../../../../packages/client/ui-conversation/src/client/stores.ts)), persisted beside the draft so recall survives reloads and session switches. The store action `pushHistory` owns the write policy: consecutive duplicates collapse (shell-history style) and the tail is bounded at 200 entries. The shell appends the exact clipboard projection at Enter time (chips already folded to their `/command` / `@ref` text forms, so a recalled line re-decorates on scan); whitespace-only drafts and attachment-only sends record nothing. Bind/unbind plumbing mirrors `bindDraftMirror`: `bindHistory` is injected through the `conversation.session` slot and wired in the same mount effect, with a render-ref feeding the shell's lazy read thunk.

## Alternatives considered

**Arrow Up/Down unconditionally, like Codex's TUI.** Conflicts with caret movement in a multi-line plain-text editor; the adopted boundary rule (top/bottom line, single-line short-circuit) keeps the arrows working as caret movers between lines while giving single-line drafts the shell-prompt gesture.

**Read history from the session transcript.** The transcript is paged and virtualized — deep entries may not be loaded client-side, and transcript text is the *serialized* (chip-expanded) form rather than the user's typed form. A composer-owned list records exactly what was entered, at the cost of ignoring prompts submitted from another window of the same session.

**Keep the list in memory on the shell.** Loses recall across reloads and session teardown; the existing persisted Conversation store already owns per-Session composer state, so appending one key is the symmetric home.

**Dedupe every duplicate, not just consecutive.** Would reorder semantics on resend (the resent entry should land at the tail like any submission) and requires an O(n) scan per append for no user-visible gain.

## Consequences

`ConversationStoreState` gains the optional `history` key (optional because the pre-release persistence layer wholesale-replaces state from older blobs), `ComposerKeyboard` gains `recall`, and the `conversation.session` injected props gain `bindHistory`; both test harnesses constructing the entry learned the new prop. The 200-entry bound is a product constant alongside `HISTORY_MERGE_DELAY_MS`, not a config field. Recall of a recalled command line re-enters adjudication on submit rather than its original claim (claims are pick-time state), which matches retyped behavior. Package specs cover the walk, the dedup/limit policy, key routing, and cursor reset on submit.