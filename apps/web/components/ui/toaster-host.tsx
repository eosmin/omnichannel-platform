'use client'

import type { ComponentType, ReactElement } from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { isToastRequested, retryToasts, subscribeToasts } from '../../lib/toast'

// `sonner` is its own chunk, fetched when the first toast is asked for (see `lib/toast.ts`). It is
// imported here by hand and not with `next/dynamic`, which throws in render when the chunk cannot be
// loaded (offline, a deploy replaced it): a toast must never take the page down. If the load fails, the
// next toast tries again.
export function ToasterHost(): ReactElement | null {
  const requested = useSyncExternalStore(subscribeToasts, isToastRequested, () => false)
  const [Loaded, setLoaded] = useState<ComponentType | null>(null)
  useEffect(() => {
    if (!requested || Loaded !== null) return
    let current = true
    import('./toaster-loaded').then(
      module => {
        if (current) setLoaded(() => module.default)
      },
      () => retryToasts()
    )
    return () => {
      current = false
    }
  }, [requested, Loaded])
  return Loaded === null ? null : <Loaded />
}
