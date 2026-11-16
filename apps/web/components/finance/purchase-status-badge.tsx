import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { PurchaseOrderStatus } from '@platform/core/domain'

import { cn } from '../../lib/utils'

const TONES: Record<PurchaseOrderStatus, string> = {
  [PurchaseOrderStatus.DRAFT]: 'bg-muted text-muted-foreground',
  [PurchaseOrderStatus.ORDERED]: 'bg-primary/10 text-primary',
  [PurchaseOrderStatus.PARTIALLY_RECEIVED]: 'bg-primary/10 text-primary',
  [PurchaseOrderStatus.RECEIVED]: 'bg-muted text-foreground',
  [PurchaseOrderStatus.CLOSED]: 'bg-muted text-foreground',
  [PurchaseOrderStatus.CANCELLED]: 'bg-muted text-muted-foreground line-through'
}

// The status of a purchase order in words (never by color alone)
export function PurchaseStatusBadge({ status }: { status: PurchaseOrderStatus }): ReactElement {
  const t = useTranslations('finance.purchases.status')
  return (
    <span
      data-testid="purchase-status"
      data-status={status}
      className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONES[status])}
    >
      {t(status)}
    </span>
  )
}
