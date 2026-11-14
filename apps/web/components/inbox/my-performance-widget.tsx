'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { formatDuration } from '../../lib/analytics/duration'
import { useMyPerformance } from '../../lib/analytics/use-analytics-data'
import { useStore } from '../providers/store-context'

// What the agent did today: resolved, open and how fast they answered first (TDD_09 §8). It is read live and only of the
// person, so it needs no analytics permission: a person always sees their own day.
export function MyPerformanceWidget(): ReactElement {
  const t = useTranslations('inbox.sidebar.performance')
  const format = useFormatter()
  const locale = useLocale()
  const { storeId } = useStore()
  const performance = useMyPerformance(storeId)

  // A refresh that fails keeps the figures of the last one: the alert is for a widget that has none
  if (performance.data === undefined && performance.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('failed')}
      </p>
    )
  }
  if (performance.data === undefined) {
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>
  }
  const { resolved, open, medianFirstResponseSeconds } = performance.data
  const average =
    medianFirstResponseSeconds === null ? null : formatDuration(medianFirstResponseSeconds, locale)
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{t('resolved')}</dt>
      <dd className="text-right font-medium tabular-nums">{format.number(resolved)}</dd>
      <dt className="text-muted-foreground">{t('open')}</dt>
      <dd className="text-right font-medium tabular-nums">{format.number(open)}</dd>
      <dt className="text-muted-foreground">{t('average')}</dt>
      <dd className="text-right font-medium tabular-nums">{average ?? t('noAverage')}</dd>
    </dl>
  )
}
