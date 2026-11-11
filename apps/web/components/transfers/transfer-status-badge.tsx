import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { TransferStatus } from '@platform/core/domain'

import { cn } from '../../lib/utils'

const TONES: Record<TransferStatus, string> = {
  [TransferStatus.DRAFT]: 'bg-muted text-muted-foreground',
  [TransferStatus.IN_TRANSIT]: 'bg-primary/10 text-primary',
  [TransferStatus.RECEIVED]: 'bg-muted text-foreground',
  [TransferStatus.CANCELLED]: 'bg-muted text-muted-foreground line-through'
}

// The status of a transfer in words (never by color alone)
export function TransferStatusBadge({ status }: { status: TransferStatus }): ReactElement {
  const t = useTranslations('transfers.status')
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONES[status])}>
      {t(status)}
    </span>
  )
}
