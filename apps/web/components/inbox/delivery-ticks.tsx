'use client'

import { Check, CheckCheck, Clock, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { DeliveryStatus } from '@platform/core/domain'

import type { DeliveryTicks } from '../../lib/inbox/thread-items'
import { cn } from '../../lib/utils'

const ICONS = {
  [DeliveryStatus.QUEUED]: Clock,
  [DeliveryStatus.SENT]: Check,
  [DeliveryStatus.DELIVERED]: CheckCheck,
  [DeliveryStatus.READ]: CheckCheck,
  [DeliveryStatus.FAILED]: TriangleAlert
} as const

// The state of a reply toward the channel. The icon changes with the state and the word is there for
// who cannot see it: the color only adds to it (read is the strongest, delivered the same two ticks).
export function DeliveryTicksIcon({ status }: { status: DeliveryTicks }): ReactElement {
  const t = useTranslations('inbox.thread.ticks')
  const Icon = ICONS[status]
  return (
    <span
      className={cn(
        'inline-flex items-center',
        status === DeliveryStatus.FAILED ? 'text-destructive' : 'text-muted-foreground',
        status === DeliveryStatus.READ && 'text-foreground'
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{t(status)}</span>
    </span>
  )
}
