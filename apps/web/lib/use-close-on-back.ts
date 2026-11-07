'use client'

import { useEffect, useRef } from 'react'

// The key of the step that a dialog takes in the history of the browser
const DIALOG_STATE_KEY = 'platformDialog'

interface OpenDialog {
  // Closes the dialog because of the Back of the browser
  closeByBack: () => void
}

// The dialogs that are open, the last one on top: one Back closes one dialog, the one on top
const openDialogs: OpenDialog[] = []
// A dialog closed by something else than Back (Escape, its own button, a save) leaves its step in the history. The
// step is not taken back at once, because the app may be navigating at that very moment (a save that goes to
// another page) and a step back would undo it. It is skipped the next time the person presses Back, below.
let isStepLeftBehind = false
// The address the step was left on: a Back to another address is not a Back out of the step
let staleHref = ''
let isListening = false

const hasDialogStep = (): boolean => {
  const state: unknown = window.history.state
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Record<string, unknown>)[DIALOG_STATE_KEY] === true
  )
}

// One listener for the page, for the life of the page: the dialogs come and go, the steps do not
function onPopState(): void {
  const top = openDialogs.at(-1)
  if (top !== undefined) {
    top.closeByBack()
    return
  }
  // No dialog is open: the Back landed on the step of a dialog that closed earlier (the app navigated since),
  // or on the page it was taken from (nothing navigated). Either way that step is not a place of its own:
  // the Back goes on to the real previous page.
  if (isStepLeftBehind && (hasDialogStep() || window.location.href === staleHref)) {
    isStepLeftBehind = false
    window.history.back()
  }
}

function listenOnce(): void {
  if (isListening) return
  isListening = true
  window.addEventListener('popstate', onPopState)
}

// The browser's Back while a dialog is open. A dialog takes one step in the history when it opens, so that Back
// closes the dialog and stays on the page (it used to leave the page, and the dialog went with it). A step that
// a dialog leaves behind when it closes any other way is skipped by the next Back, and another dialog that opens
// first uses it. The state of the step is a copy of the current one (Next keeps its own marks in it, and a
// state without them would make its router reload the page). Only history traversal fires `popstate`; the
// app's own `push` does not.
export function useCloseOnBack(
  isOpen: boolean,
  onOpenChange: ((open: boolean) => void) | undefined
): void {
  const latest = useRef(onOpenChange)
  useEffect(() => {
    latest.current = onOpenChange
  })
  useEffect(() => {
    if (!isOpen) return
    listenOnce()
    if (isStepLeftBehind && hasDialogStep() && window.location.href === staleHref) {
      // A dialog just closed and left its step on the current entry: this one uses it
      isStepLeftBehind = false
    } else {
      const current: unknown = window.history.state
      window.history.pushState(
        {
          ...(typeof current === 'object' && current !== null ? current : {}),
          [DIALOG_STATE_KEY]: true
        },
        '',
        window.location.href
      )
    }
    let wasClosedByBack = false
    const entry: OpenDialog = {
      closeByBack: () => {
        wasClosedByBack = true
        latest.current?.(false)
      }
    }
    openDialogs.push(entry)
    return () => {
      const at = openDialogs.indexOf(entry)
      if (at !== -1) openDialogs.splice(at, 1)
      if (!wasClosedByBack) {
        isStepLeftBehind = true
        staleHref = window.location.href
      }
    }
  }, [isOpen])
}
