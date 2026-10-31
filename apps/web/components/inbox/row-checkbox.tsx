'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { ConversationListItemView } from '@platform/api-client'

import { useCustomerName } from '../../lib/inbox/use-customer-name'
import { cn } from '../../lib/utils'

// The checkbox over the avatar of a row (TDD_09 §10): it shows on hover or focus, and always once
// something is ticked or on a touch screen, which has no hover. It is a sibling of the row's link, not
// inside it: a control inside a link is read as one.
export function RowCheckbox({
  customer,
  channelName,
  isChecked,
  isSelecting,
  onToggle
}: {
  customer: ConversationListItemView['customer']
  channelName: string
  isChecked: boolean
  // Something is ticked, so every row shows its checkbox
  isSelecting: boolean
  onToggle: () => void
}): ReactElement {
  const t = useTranslations('inbox.bulk')
  const { name } = useCustomerName(customer, channelName)
  return (
    <label
      className={cn(
        'bg-background absolute top-2 left-3 flex size-10 cursor-pointer items-center justify-center rounded-full border',
        'group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
        isChecked || isSelecting ? 'opacity-100' : 'opacity-0'
      )}
    >
      <input
        type="checkbox"
        className="accent-primary size-4"
        checked={isChecked}
        aria-label={t('selectRow', { name })}
        onChange={onToggle}
      />
    </label>
  )
}
