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
  return {
    onOpenAutoFocus: event => {
      // Radix has not moved the focus yet: this is still the button that was pressed
      opener.current = openerOf(document.activeElement)
      onOpenAutoFocus?.(event)
    },
    onCloseAutoFocus: event => {
      onCloseAutoFocus?.(event)
      returnFocus(event, opener.current, target => (document.activeElement as unknown) === target)
      opener.current = null
    }
  }
}
