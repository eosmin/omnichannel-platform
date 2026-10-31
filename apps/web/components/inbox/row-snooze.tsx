'use client'

import { AlarmClock } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { ConversationListItemView } from '@platform/api-client'

import { useCustomerName } from '../../lib/inbox/use-customer-name'

// The snooze button over a row: it opens the dialog of that conversation without opening the
// conversation. Like the checkbox it is a sibling of the link and shows on hover or focus, and always
// on a touch screen.
export function RowSnooze({
  customer,
  channelName,
  onSnooze
}: {
  customer: ConversationListItemView['customer']
  channelName: string
  onSnooze: () => void
}): ReactElement {
  const t = useTranslations('inbox.actions')
  const { name } = useCustomerName(customer, channelName)
  return (
    <button
      type="button"
      aria-label={t('snoozeRow', { name })}
      onClick={onSnooze}
      className="bg-background hover:bg-accent focus-visible:ring-ring pointer-events-none absolute right-2 bottom-1.5 flex size-8 items-center justify-center rounded-md border opacity-0 outline-none group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
    >
      <AlarmClock aria-hidden className="size-4" />
    </button>
  )
}
