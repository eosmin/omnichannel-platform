'use client'

import { type ReactElement, useState } from 'react'

import { cn } from '../../lib/utils'

// The photo is a link that a plugin chose and that expires: when it fails to load, or there is none,
// the initials show. `referrerPolicy` keeps the address of the inbox from reaching the CDN.
export function CustomerAvatar({
  avatarUrl,
  initials,
  className
}: {
  avatarUrl: string | null
  initials: string
  className?: string
}): ReactElement {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showPhoto = avatarUrl !== null && failedUrl !== avatarUrl
  return (
    <span
      aria-hidden
      className={cn(
        'bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-medium',
        className
      )}
    >
      {showPhoto ? (
        // eslint-disable-next-line @next/next/no-img-element -- a remote link of unknown size and host: next/image would need each host configured
        <img
          src={avatarUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        initials
      )}
    </span>
  )
}
