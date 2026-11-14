'use client'

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { type MetricsRequest, type MetricsResultView } from '@platform/api-client'
import { TimeGranularity } from '@platform/core/analytics'

import { formatDuration } from '../../lib/analytics/duration'
import {
  changeOf,
  ChangeTones,
  type KpiDefinition,
  KpiKinds,
  toneOf,
  wholeStoreSummary
} from '../../lib/analytics/summary'
import { useMetrics } from '../../lib/analytics/use-analytics-data'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'

const TONE_CLASS = {
  [ChangeTones.BETTER]: 'text-emerald-700 dark:text-emerald-400',
  [ChangeTones.WORSE]: 'text-destructive',
  [ChangeTones.SAME]: 'text-muted-foreground'
} as const

export interface KpiRanges {
  current: { from: string; to: string }
  previous: { from: string; to: string }
}

function requestOf(definition: KpiDefinition, range: { from: string; to: string }): MetricsRequest {
  return { metric: definition.metric, granularity: TimeGranularity.DAY, ...range }
}

// A figure of the top of the dashboard with its change from the period before: two reads, one for each period. The arrow and the
// word say the direction; the color says only whether it is good, so the card is read without telling the colors apart.
export function KpiCard({
  definition,
  ranges
}: {
  definition: KpiDefinition
  ranges: KpiRanges
}): ReactElement {
  const t = useTranslations('analytics.kpi')
  const format = useFormatter()
  const locale = useLocale()
  const { storeId } = useStore()
  const current = useMetrics(storeId, requestOf(definition, ranges.current))
  const previous = useMetrics(storeId, requestOf(definition, ranges.previous))

  const text = (result: MetricsResultView | undefined): string | null => {
    const summary = wholeStoreSummary(result)
    // A time of nothing is no time; a count of nothing is zero
    if (summary === null) return definition.kind === KpiKinds.COUNT ? format.number(0) : null
    if (definition.kind === KpiKinds.DURATION) return formatDuration(summary.value, locale)
    if (definition.kind === KpiKinds.MONEY) {
      return format.number(summary.value, { style: 'currency', currency: 'USD' })
    }
    return format.number(summary.value)
  }
  const valueOf = (result: MetricsResultView | undefined): number | null =>
    wholeStoreSummary(result)?.value ?? (definition.kind === KpiKinds.COUNT ? 0 : null)

  const change = changeOf(valueOf(current.data), valueOf(previous.data))
  const tone = change === null ? null : toneOf(change, definition.betterWhen)
  const Arrow =
    change === null || tone === ChangeTones.SAME ? Minus : change > 0 ? ArrowUp : ArrowDown
  const isFailed = current.isError || previous.isError
  // The change waits for both periods: with only one, "nothing to compare with" would flash and then turn into a number
  const isReady = current.data !== undefined && previous.data !== undefined

  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <h2 className="text-muted-foreground text-xs font-medium">{t(`${definition.id}.title`)}</h2>
      {isFailed ? (
        <p role="alert" className="text-destructive text-sm">
          {t('failed')}
        </p>
      ) : !isReady ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      ) : (
        <>
          <p className="text-2xl font-semibold tabular-nums">{text(current.data) ?? t('noData')}</p>
          {change === null || tone === null ? (
            <p className="text-muted-foreground text-xs">{t('noComparison')}</p>
          ) : (
            <p className={cn('flex items-center gap-1 text-xs', TONE_CLASS[tone])}>
              <Arrow aria-hidden className="size-3" />
              <span>
                {format.number(change, {
                  style: 'percent',
                  maximumFractionDigits: 1,
                  signDisplay: 'exceptZero'
                })}
              </span>
              <span className="text-muted-foreground">{t('vsPrevious')}</span>
            </p>
          )}
        </>
      )}
    </div>
  )
}
