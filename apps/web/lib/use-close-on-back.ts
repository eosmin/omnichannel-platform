'use client'

import { useEffect, useRef } from 'react'

// The browser's Back (or Forward) while a dialog is open: the dialog goes with the page it belonged to. Without
// this the route changes under a dialog that keeps its own state, and a click on its button acts on a thing
// that is no longer on the screen. Only history traversal fires `popstate`; the app's own `push` does not.
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
    const close = (): void => latest.current?.(false)
    window.addEventListener('popstate', close)
    return () => window.removeEventListener('popstate', close)
  }, [isOpen])
}
