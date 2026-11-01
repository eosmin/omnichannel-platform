'use client'

import type { CSSProperties, ReactElement } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

export function Toaster(props: ToasterProps): ReactElement {
  return (
    <Sonner
      // The app has no dark mode yet: sonner must not follow the operating system on its own
      theme="light"
      className="toaster group"
      // A modal dialog or a sheet (the customer panel) sets pointer-events: none on the body, and the
      // toasts live there: without this, an action in a toast cannot be clicked while one is open
      toastOptions={{ style: { pointerEvents: 'auto' } }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)'
        } as CSSProperties
      }
      {...props}
    />
  )
}
