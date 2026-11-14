'use client'

import { CalendarClock, Download } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useMemo, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { DateRangePresets } from '@platform/core/analytics'
import { ClientPermissions } from '@platform/core/auth'
import { SearchReportConfig } from '@platform/core/domain'

import { AgentPanel, ChannelPanel, VolumePanel } from '../../components/analytics/dashboard-panels'
import { ExportDialog } from '../../components/analytics/export-dialog'
import { KpiCard } from '../../components/analytics/kpi-card'
import { SearchPanel } from '../../components/analytics/search-panel'
import { useStore } from '../../components/providers/store-context'
import { PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
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

// `YYYY-MM-DD` of an ISO date-time
const DAY_LENGTH = 10

// The dashboard of the store (TDD_11 §7.3), read from the rollup tables. Every figure is of whole UTC days that are over, and
// is compared with the period of the same length right before.
export function AnalyticsPage(): ReactElement {
  const t = useTranslations('analytics')
  const { storeId, can } = useStore()
  const id = useId()
  const [choice, setChoice] = useState(DEFAULT_ANALYTICS_RANGE)
  const [exporting, setExporting] = useState(false)
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
        <div className="flex flex-wrap items-end gap-3">
          {can(ClientPermissions.ANALYTICS_EXPORT) ? (
            <Button variant="outline" onClick={() => setExporting(true)}>
              <Download aria-hidden />
              {t('pageActions.export')}
            </Button>
          ) : null}
          {can(ClientPermissions.ANALYTICS_MANAGE_REPORTS) ? (
            <Button variant="outline" asChild>
              <Link href={AppPaths.store.analyticsReports(storeId)}>
                <CalendarClock aria-hidden />
                {t('pageActions.reports')}
              </Link>
            </Button>
          ) : null}
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
      {/* The report looks back from now: it cannot show a calendar month that is over, so it stays out of that range */}
      {choice === DateRangePresets.LAST_MONTH ? null : (
        <SearchPanel days={Math.min(ranges.days.length, SearchReportConfig.MAX_DAYS)} />
      )}
      <p className="text-muted-foreground text-xs">{t('utcNote')}</p>
      {can(ClientPermissions.ANALYTICS_EXPORT) ? (
        <ExportDialog
          open={exporting}
          onOpenChange={setExporting}
          from={ranges.current.from.slice(0, DAY_LENGTH)}
          to={ranges.current.to.slice(0, DAY_LENGTH)}
        />
      ) : null}
    </div>
  )
}
