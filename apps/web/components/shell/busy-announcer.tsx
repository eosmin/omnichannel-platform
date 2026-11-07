'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useSyncExternalStore } from 'react'

import { readBusyCount, subscribeToBusy } from '../../lib/busy-announcer'

// The one live region of the app for "something is working": always on the page, empty until a button waits,
// so that the change of its text is announced. The words of the button do not change.
export function BusyAnnouncer(): ReactElement {
  const t = useTranslations('common')
  const count = useSyncExternalStore(subscribeToBusy, readBusyCount, () => 0)
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {count > 0 ? t('working') : ''}
    </div>
  )
}
