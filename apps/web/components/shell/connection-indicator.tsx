'use client'

import { WifiOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useSyncExternalStore } from 'react'

import {
  ConnectionStatuses,
  type ConnectionStatusStore
} from '../../lib/realtime/connection-status'
import { useRealtime } from '../../lib/realtime/realtime-context'

// Connected and connecting show nothing. The amber dot says the socket is coming back; the red banner
// says it has not for a while. Both are announced to screen readers when they appear.
export function ConnectionIndicator(): ReactElement | null {
  const realtime = useRealtime()
  return realtime === null ? null : <StatusView store={realtime.status} />
}

function StatusView({ store }: { store: ConnectionStatusStore }): ReactElement | null {
  const t = useTranslations('realtime')
  const status = useSyncExternalStore(store.subscribe, store.get, store.get)

  if (status === ConnectionStatuses.RECONNECTING) {
    return (
      <div
        role="status"
        className="text-muted-foreground flex items-center gap-2 px-4 py-1 text-xs"
      >
        <span aria-hidden className="size-2 rounded-full bg-amber-500" />
        {t('reconnecting')}
      </div>
    )
  }
  if (status === ConnectionStatuses.DISCONNECTED) {
    return (
      <div
        role="alert"
        className="bg-destructive flex items-center gap-2 px-4 py-2 text-sm text-white"
      >
        <WifiOff aria-hidden className="size-4" />
        {t('disconnected')}
      </div>
    )
  }
  return null
}
