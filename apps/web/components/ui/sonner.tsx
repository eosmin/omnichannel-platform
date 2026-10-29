'use client'

import type { CSSProperties, ReactElement } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

export function Toaster(props: ToasterProps): ReactElement {
  return (
    <Sonner
      // The app has no dark mode yet: sonner must not follow the operating system on its own
      theme="light"
      className="toaster group"
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
