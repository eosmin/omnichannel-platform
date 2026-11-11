import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { CountStatus } from '@platform/core/domain'

import { cn } from '../../lib/utils'

// The state of a count in words (never in colour alone)
const TONES: Record<CountStatus, string> = {
  [CountStatus.DRAFT]: 'bg-muted text-muted-foreground',
  [CountStatus.COUNTING]: 'bg-primary/10 text-primary',
  [CountStatus.REVIEW]: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  [CountStatus.APPLIED]: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  [CountStatus.CANCELLED]: 'bg-muted text-muted-foreground line-through'
}

export function CountStatusBadge({ status }: { status: CountStatus }): ReactElement {
  const t = useTranslations('counts.status')
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', TONES[status])}>
      {t(status)}
    </span>
  )
}
