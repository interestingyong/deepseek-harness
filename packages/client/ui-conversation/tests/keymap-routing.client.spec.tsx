// @vitest-environment jsdom
/**
 * Keymap routing at the DOM boundary: synthetic keydowns on the
 * contenteditable reach the registered composer commands (the jsdom lane's
 * gesture entry, below the full component bench).
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { createEditor } from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { registerComposerKeymap } from '../src/client/input/editor/keymap.ts'

describe('keymap keydown routing', () => {
  it('routes Enter to the keymap submit handler', () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    const submit = vi.fn()
    registerComposerKeymap(editor, {
      arbitrate: () => 'pass',
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit,
      intakeFiles: () => {},
      pasteText: () => {},
      page: () => false,
    })
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith(false)
    fireEvent.keyDown(root, { key: 'Enter', metaKey: true })
    expect(submit).toHaveBeenCalledWith(true)
  })

  it('routes Tab through arbitration and passes when unconsumed', () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    const arbitrate = vi.fn<(key: string, composing: boolean) => 'consumed' | 'pick-highlighted' | 'pass'>()
      .mockReturnValueOnce('consumed')
      .mockReturnValueOnce('pick-highlighted')
      .mockReturnValue('pass')
    registerComposerKeymap(editor, {
      arbitrate,
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit: () => {},
      intakeFiles: () => {},
      pasteText: () => {},
      page: () => false,
    })
    const consumed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(arbitrate).toHaveBeenCalledWith('tab', false)
    expect(consumed).toBe(false) // consumed: preventDefault fired
    const picked = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(picked).toBe(false) // picked: the completion replaces native traversal
    const passed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(passed).toBe(true) // pass: the browser keeps native focus traversal
  })

  it('routes PageUp/PageDown to the recall handler and consumes applied recalls', () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    const page = vi.fn<(direction: 'older' | 'newer', composing: boolean) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    registerComposerKeymap(editor, {
      arbitrate: () => 'pass',
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit: () => {},
      intakeFiles: () => {},
      pasteText: () => {},
      page,
    })
    const up = fireEvent.keyDown(root, { key: 'PageUp' })
    expect(page).toHaveBeenCalledWith('older', false)
    expect(up).toBe(false) // recalled: the native editable scroll is suppressed
    const down = fireEvent.keyDown(root, { key: 'PageDown' })
    expect(page).toHaveBeenCalledWith('newer', false)
    expect(down).toBe(false)
    const refused = fireEvent.keyDown(root, { key: 'PageUp' })
    expect(refused).toBe(true) // refused: the browser keeps native scrolling
    // Modifier chords never reach recall (Ctrl+PageUp traverses elsewhere).
    page.mockClear()
    fireEvent.keyDown(root, { key: 'PageUp', ctrlKey: true })
    expect(page).not.toHaveBeenCalled()
  })
})
