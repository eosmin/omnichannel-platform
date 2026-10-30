'use client'

import { type ReactNode, useState } from 'react'

// An image whose link a plugin or a provider chose and that may expire: when it fails to load, or
// there is none, the fallback shows. `referrerPolicy` keeps the address of the inbox from reaching
// the CDN, and the CSP `img-src` decides which hosts may be drawn at all.
export function RemoteImage({
  src,
  className,
  fallback = null
}: {
  src: string | null
  className?: string
  fallback?: ReactNode
}): ReactNode {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (src === null || failedSrc === src) return fallback
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a remote link of unknown size and host: next/image would need each host configured
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => setFailedSrc(src)}
    />
  )
}
