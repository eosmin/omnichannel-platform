'use client'

import { useRef } from 'react'

import { type FocusTarget, openerOf, returnFocus } from './focus-return'

interface AutoFocusProps {
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
}

// What a Radix dialog content takes to give the focus back, when it closes, to who held it before it
// opened. The handlers the caller passes run first and may keep the default.
export function useFocusReturn({
  onOpenAutoFocus,
  onCloseAutoFocus
}: AutoFocusProps): AutoFocusProps {
  const opener = useRef<FocusTarget | null>(null)
  // Read while the content renders for the first time, which is before anything is mounted: a field
  // with `autoFocus` takes the focus when it mounts, earlier than Radix's `onOpenAutoFocus`, and would
  // be taken for the opener (and be gone when the dialog closes). The content exists only while the
  // dialog is open, so this runs once per opening. Nothing to read on the server.
  if (opener.current === null && typeof document !== 'undefined') {
    opener.current = openerOf(document.activeElement)
  }
  return {
    onOpenAutoFocus,
    onCloseAutoFocus: event => {
      onCloseAutoFocus?.(event)
      returnFocus(event, opener.current, target => (document.activeElement as unknown) === target)
    }
  }
}
