'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useMemo, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { AgentPanel, ChannelPanel, VolumePanel } from '../../components/analytics/dashboard-panels'
import { KpiCard } from '../../components/analytics/kpi-card'
import { useStore } from '../../components/providers/store-context'
import { PermissionDenied } from '../../components/settings/states'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import {
  AnalyticsRanges,
  DEFAULT_ANALYTICS_RANGE,
  daysOf,
  isAnalyticsRange,
  previousRangeOf,
  rangeOf
} from '../../lib/analytics/date-range'
import { KPIS } from '../../lib/analytics/summary'

// The dashboard of the store (TDD_11 §7.3), read from the rollup tables. Every figure is of whole UTC days that are over, and
// is compared with the period of the same length right before.
export function AnalyticsPage(): ReactElement {
  const t = useTranslations('analytics')
  const { can } = useStore()
  const id = useId()
  const [choice, setChoice] = useState(DEFAULT_ANALYTICS_RANGE)
  // Fixed when the page opens: a page left open across midnight keeps the days it drew until the person changes the range
  const [now] = useState(() => new Date())
  const ranges = useMemo(() => {
    const current = rangeOf(choice, now)
    const previous = previousRangeOf(choice, now)
    return {
      days: daysOf(current),
      current: { from: current.from.toISOString(), to: current.to.toISOString() },
      previous: { from: previous.from.toISOString(), to: previous.to.toISOString() }
    }
  }, [choice, now])

  if (!can(ClientPermissions.ANALYTICS_VIEW)) {
    return <PermissionDenied permission={ClientPermissions.ANALYTICS_VIEW} />
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('intro')}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-range`}>{t('range.label')}</Label>
          <select
            id={`${id}-range`}
            className={`${SELECT_CLASS} sm:w-48`}
            value={choice}
            onChange={event => {
              if (isAnalyticsRange(event.target.value)) setChoice(event.target.value)
            }}
          >
            {AnalyticsRanges.map(range => (
              <option key={range} value={range}>
                {t(`range.${range}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {KPIS.map(definition => (
          <KpiCard key={definition.id} definition={definition} ranges={ranges} />
        ))}
      </div>
      <VolumePanel range={ranges.current} days={ranges.days} />
      <div className="grid gap-4 lg:grid-cols-2">
        <AgentPanel range={ranges.current} />
        <ChannelPanel range={ranges.current} />
      </div>
      <p className="text-muted-foreground text-xs">{t('utcNote')}</p>
    </div>
  )
}
