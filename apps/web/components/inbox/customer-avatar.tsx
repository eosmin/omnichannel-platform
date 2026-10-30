'use client'

import type { ReactElement } from 'react'

import { cn } from '../../lib/utils'

import { RemoteImage } from './remote-image'

// The photo is a link that a plugin chose and that expires: when it fails to load, or there is none,
// the initials show.
export function CustomerAvatar({
  avatarUrl,
  initials,
  className
}: {
  avatarUrl: string | null
  initials: string
  className?: string
}): ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-medium',
        className
      )}
    >
      <RemoteImage src={avatarUrl} className="size-full object-cover" fallback={initials} />
    </span>
  )
}
