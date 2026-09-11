/**
 * Composer keymap over the Lexical command layer: menu arbitration
 * (arrows/escape/enter), space adjudication, the Enter submit gesture, and
 * paste routing. Registered at CRITICAL priority so it decides before
 * @lexical/plain-text's own Enter/paste defaults; a handler returning false
 * falls through to those defaults (Shift+Enter's line break, ordinary
 * spaces, text paste the bar routes itself).
 *
 * Draft recall (PageUp/PageDown, plus Arrow Up/Down at the first/last line)
 * walks the session's submitted drafts. PageUp/PageDown ride a plain
 * root-element keydown listener (no Lexical command map); Arrow Up/Down are
 * intercepted at CRITICAL priority and recall only when the caret sits on the
 * top/bottom line of the document, so multi-line caret movement keeps the
 * arrows elsewhere. A refused recall (no history, busy phase, open menu) falls
 * through to the native editable scroll or Lexical's caret move.
 *
 * IME guard: a composition-closing Enter/Space must not submit or adjudicate.
 * KeyboardEvent.isComposing covers most engines; Safari delivers the closing
 * keydown AFTER compositionend, so a root-element composition watch holds the
 * guard for 10ms more (the old textarea's proven window); keyCode
 * 229 is the legacy signal engines emit without isComposing.
 */
import type { LexicalEditor } from 'lexical'
import {
  COMMAND_PRIORITY_CRITICAL, KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND, KEY_SPACE_COMMAND, KEY_TAB_COMMAND, PASTE_COMMAND,
  $getRoot, $getSelection, $isRangeSelection,
} from 'lexical'
import type { ElementNode, LexicalNode, PointType } from 'lexical'
import { mergeRegister } from '@lexical/utils'
import type { ArbitrateKey, ArbitrateOutcome, DraftRecallDirection } from '../../contract/input.ts'

/** Vertical edge the caret must sit on for an Arrow key to recall history. */
type VerticalEdge = 'top' | 'bottom'

/**
 * Whether the collapsed caret sits on the top ('top') or bottom ('bottom')
 * line of the document — the only positions where Arrow Up/Down recall
 * history instead of moving the caret (bash/readline boundary). Empty
 * documents answer both edges so the first recall needs no caret to start.
 * Must run inside an editor read/update.
 */
function caretAtVerticalBoundary(edge: VerticalEdge): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
  const root = $getRoot()
  const blocks = root.getChildren()
  if (blocks.length === 0) return true
  // A single-line composer behaves like a shell prompt: Arrow Up/Down always
  // walk history regardless of the caret's horizontal position. Multi-line
  // editors keep the boundary so the arrows move the caret between lines.
  if (blocks.length === 1) return true
  const anchor = selection.anchor
  const anchorNode = anchor.getNode()
  // The paragraph (or root) the anchor lives in; a bare-root anchor stays root.
  const block = anchorNode.getKey() === root.getKey()
    ? anchorNode
    : (anchorNode.getTopLevelElement() ?? anchorNode)
  const target = edge === 'top' ? blocks[0] : blocks[blocks.length - 1]
  if (block !== target) return false
  return edge === 'top' ? caretAtBlockStart(anchor) : caretAtBlockEnd(anchor, target)
}

/** Whether the anchor sits at the start of its block (offset 0 on the first text/element child). */
function caretAtBlockStart(anchor: PointType): boolean {
  if (anchor.type === 'element') return anchor.offset === 0
  if (anchor.offset !== 0) return false
  const node = anchor.getNode()
  const parent = node.getParent()
  return parent === null || node === parent.getFirstChild()
}

/** Whether the anchor sits at the end of its block (last child, offset at its length). */
function caretAtBlockEnd(anchor: PointType, block: LexicalNode): boolean {
  if (anchor.type === 'element') {
    const size = 'getChildrenSize' in block ? (block as ElementNode).getChildrenSize() : 0
    return anchor.offset === size
  }
  const node = anchor.getNode()
  const parent = node.getParent()
  if (parent === null) return anchor.offset === node.getTextContent().length
  return node === parent.getLastChild() && anchor.offset === node.getTextContent().length
}

/** The bar-supplied behavior behind each intercepted gesture. */
export interface ComposerKeymapHandlers {
  /** Keyboard arbitration while the menu is open ('pass' when no pipeline). */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** Space adjudication; true = a claim was applied — the keystroke is consumed. */
  space(): boolean
  /** Dismiss the popupSelect shell (Escape layering: an open overlay closes first). */
  dismissPopup(): void
  /** Whether Enter may submit right now (locked/busy states refuse). */
  canSubmit(): boolean
  /** The Enter gesture after every guard passed; `accelerated` = Ctrl/Cmd held. */
  submit(accelerated: boolean): void
  /** Pasted files (image intake). */
  intakeFiles(files: readonly File[]): void
  /** Pasted plain text (sanitized insertion through the shell). */
  pasteText(text: string): void
  /**
   * PageUp/PageDown draft recall (plain keydown, no Lexical command map);
   * true = a recall applied — the keystroke is consumed.
   */
  page(direction: DraftRecallDirection, composing: boolean): boolean
}

/** Composition state a keydown can trust (see the module doc's Safari note). */
function isComposingEvent(event: KeyboardEvent, recentlyComposing: () => boolean): boolean {
  // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
  // oxlint-disable-next-line typescript/no-deprecated
  return event.isComposing || event.keyCode === 229 || recentlyComposing()
}

/**
 * Register the composer keymap on one editor.
 * @param editor - the shell-owned editor.
 * @param handlers - bar-supplied behavior.
 * @returns the unregister disposer.
 */
export function registerComposerKeymap(editor: LexicalEditor, handlers: ComposerKeymapHandlers): () => void {
  // Composition watch: true through composition and for one tick after
  // compositionend (Safari's late closing keydown). The listener rides the
  // root element and re-arms on root swaps.
  let composing = false
  let composingUntil = 0
  const onCompositionStart = (): void => {
    composing = true
  }
  const onCompositionEnd = (): void => {
    composing = false
    composingUntil = Date.now() + 10
  }
  const recentlyComposing = (): boolean => composing || Date.now() < composingUntil

  // PageUp/PageDown walk the submitted-draft recall; Lexical exposes no
  // command for them, so the listener rides the root element directly and
  // only consumes the keystrokes the recall actually applies. Modifier
  // chords (Ctrl/Cmd/Alt) stay native: they page or traverse elsewhere.
  const onPageKey = (event: KeyboardEvent): void => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const consumed = handlers.page(
      event.key === 'PageUp' ? 'older' : 'newer',
      isComposingEvent(event, recentlyComposing),
    )
    if (consumed) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const arrow = (key: ArbitrateKey) => (event: KeyboardEvent | null): boolean => {
    const inComposition = event !== null && isComposingEvent(event, recentlyComposing)
    if (handlers.arbitrate(key, inComposition) !== 'pass') {
      event?.preventDefault()
      return true
    }
    // Arrow Up/Down recall history at the document's top/bottom line
    // (bash/readline boundary); anywhere else the caret moves normally. Read
    // the committed state (not a fresh update): the command handler already
    // runs inside Lexical's keydown dispatch, where editor.read() would start
    // a nested update and throw; the caret is still at its pre-move position.
    if (!inComposition && (key === 'up' || key === 'down')) {
      const edge: VerticalEdge = key === 'up' ? 'top' : 'bottom'
      if (editor.getEditorState().read(() => caretAtVerticalBoundary(edge))) {
        if (handlers.page(key === 'up' ? 'older' : 'newer', inComposition)) {
          event?.preventDefault()
          return true
        }
      }
    }
    return false
  }

  return mergeRegister(
    editor.registerRootListener((root, prevRoot) => {
      prevRoot?.removeEventListener('compositionstart', onCompositionStart)
      prevRoot?.removeEventListener('compositionend', onCompositionEnd)
      root?.addEventListener('compositionstart', onCompositionStart)
      root?.addEventListener('compositionend', onCompositionEnd)
    }),
    editor.registerRootListener((root, prevRoot) => {
      prevRoot?.removeEventListener('keydown', onPageKey)
      root?.addEventListener('keydown', onPageKey)
    }),
    editor.registerCommand(KEY_ARROW_UP_COMMAND, arrow('up'), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ARROW_DOWN_COMMAND, arrow('down'), COMMAND_PRIORITY_CRITICAL),
    // Tab acts only when the trigger menu has a highlighted completion;
    // otherwise it passes so the browser keeps its native focus traversal.
    editor.registerCommand(KEY_TAB_COMMAND, arrow('tab'), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ESCAPE_COMMAND, (event) => {
      // Escape layering: an open overlay closes; claimed without an overlay
      // does NOT release (backspacing the token is the only exit gesture).
      handlers.dismissPopup()
      if (handlers.arbitrate('escape', isComposingEvent(event, recentlyComposing)) === 'consumed') {
        event.preventDefault()
        return true
      }
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_SPACE_COMMAND, (event) => {
      if (isComposingEvent(event, recentlyComposing)) return false
      const consumed = handlers.space()
      if (consumed) {
        event.preventDefault() // claim token already carries the trailing separator
        return true
      }
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
      // Shift+Enter is the native line break UNCONDITIONALLY — decided before
      // the IME guard so a composition-closing Shift+Enter still breaks the line.
      if (event?.shiftKey === true) return false
      if (event !== null && isComposingEvent(event, recentlyComposing)) {
        // The IME consumes this Enter (candidate pick); neither submit nor
        // break the line. No preventDefault: the browser owns the gesture.
        return true
      }
      // Menu-open Enter picks the highlight through arbitration; a
      // no-highlight menu passes down to the submit gesture.
      if (handlers.arbitrate('enter', false) !== 'pass') {
        event?.preventDefault()
        return true
      }
      event?.preventDefault()
      if (event?.repeat === true) return true // held-down Enter must not machine-gun sends
      if (!handlers.canSubmit()) return true
      handlers.submit(event?.ctrlKey === true || event?.metaKey === true)
      return true
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(PASTE_COMMAND, (event) => {
      // Duck-typed: the payload union includes InputEvent, and test engines
      // deliver clipboardData on plain events.
      const clipboardData = (event as ClipboardEvent).clipboardData ?? null
      if (clipboardData === null) return false
      const files = Array.from(clipboardData.items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (files.length > 0) handlers.intakeFiles(files)
      const text = clipboardData.getData('text/plain')
      if (text === '') {
        if (files.length === 0) return false
        event.preventDefault()
        return true
      }
      event.preventDefault()
      handlers.pasteText(text)
      return true
    }, COMMAND_PRIORITY_CRITICAL),
  )
}
