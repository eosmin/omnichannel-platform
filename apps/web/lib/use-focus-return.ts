'use client'

import { useRef } from 'react'

import { type FocusTarget, openerOf, returnFocus } from './focus-return'

interface AutoFocusProps {
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
}

// The two handlers a Radix dialog content takes, to remember who held the focus before it opened and to
// give it back when it closes. The handlers the caller passes run first and may keep the default.
export function useFocusReturn({
  onOpenAutoFocus,
  onCloseAutoFocus
}: AutoFocusProps): Required<AutoFocusProps> {
  const opener = useRef<FocusTarget | null>(null)
  // Read while the content renders for the first time, which is before anything is mounted: a field
  // with `autoFocus` takes the focus when it mounts, earlier than Radix's `onOpenAutoFocus`, and would
  // be taken for the opener (and be gone when the dialog closes). The content exists only while the
  // dialog is open, so this runs once per opening. Nothing to read on the server.
  if (opener.current === null && typeof document !== 'undefined') {
    opener.current = openerOf(document.activeElement)
  }
  return {
    onOpenAutoFocus: event => {
      onOpenAutoFocus?.(event)
    },
    onCloseAutoFocus: event => {
      onCloseAutoFocus?.(event)
      returnFocus(event, opener.current, target => (document.activeElement as unknown) === target)
      opener.current = null
    }
  }
}
