import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { FiscalDocumentStatus } from '@platform/core/domain'

import { cn } from '../../lib/utils'

const TONES: Record<FiscalDocumentStatus, string> = {
  [FiscalDocumentStatus.DRAFT]: 'bg-muted text-muted-foreground',
  [FiscalDocumentStatus.QUEUED]: 'bg-muted text-foreground',
  [FiscalDocumentStatus.SUBMITTED]: 'bg-primary/10 text-primary',
  [FiscalDocumentStatus.ACCEPTED]: 'bg-primary/10 text-primary',
  [FiscalDocumentStatus.REJECTED]: 'bg-destructive/10 text-destructive',
  [FiscalDocumentStatus.VOIDED]: 'bg-muted text-muted-foreground line-through'
}

// The status of a fiscal document in words (never by color alone)
export function FiscalStatusBadge({ status }: { status: FiscalDocumentStatus }): ReactElement {
  const t = useTranslations('finance.fiscal.status')
  return (
    <span
      data-testid="fiscal-status"
      data-status={status}
      className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONES[status])}
    >
      {t(status)}
    </span>
  )
}
