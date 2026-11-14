'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { type MetricsRequest } from '@platform/api-client'
import { AnalyticsMetrics, MetricDimensions, TimeGranularity } from '@platform/core/analytics'

import { formatDuration } from '../../lib/analytics/duration'
import { breakdownOf, dailyValues } from '../../lib/analytics/summary'
import { useMetrics } from '../../lib/analytics/use-analytics-data'
import { useChannelDirectory, useMemberDirectory } from '../../lib/inbox/use-inbox-data'
import { useStore } from '../providers/store-context'

import { TrendChart } from './trend-chart'

interface Range {
  from: string
  to: string
}

const request = (
  metric: MetricsRequest['metric'],
  range: Range,
  dimension?: MetricsRequest['dimension']
): MetricsRequest => ({
  metric,
  granularity: TimeGranularity.DAY,
  ...range,
  ...(dimension === undefined ? {} : { dimension })
})

function PanelState({
  isError,
  isPending
}: {
  isError: boolean
  isPending: boolean
}): ReactElement | null {
  const t = useTranslations('analytics.panel')
  if (isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('failed')}
      </p>
    )
  }
  if (isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t('loading')}
      </p>
    )
  }
  return null
}

// The conversations that came in and the ones that were resolved, day by day (the volume chart of TDD_11 §7.3)
export function VolumePanel({
  range,
  days
}: {
  range: Range
  days: readonly string[]
}): ReactElement {
  const t = useTranslations('analytics.volume')
  const { storeId } = useStore()
  const created = useMetrics(storeId, request(AnalyticsMetrics.CONVERSATIONS_CREATED, range))
  const resolved = useMetrics(storeId, request(AnalyticsMetrics.CONVERSATIONS_RESOLVED, range))
  const state = (
    <PanelState
      isError={created.isError || resolved.isError}
      isPending={created.data === undefined || resolved.data === undefined}
    />
  )
  return (
    <section
      aria-labelledby="analytics-volume"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2 id="analytics-volume" className="text-sm font-semibold">
        {t('title')}
      </h2>
      {created.data === undefined || resolved.data === undefined ? (
        state
      ) : (
        <TrendChart
          caption={t('caption')}
          days={days}
          series={[
            {
              id: 'created',
              label: t('created'),
              values: dailyValues(created.data.series[0], days)
            },
            {
              id: 'resolved',
              label: t('resolved'),
              values: dailyValues(resolved.data.series[0], days),
              dashed: true
            }
          ]}
        />
      )}
    </section>
  )
}

// What share of the conversations came through each channel. The name is the one of the plugin that serves it.
export function ChannelPanel({ range }: { range: Range }): ReactElement {
  const t = useTranslations('analytics.channels')
  const format = useFormatter()
  const { storeId } = useStore()
  const volume = useMetrics(
    storeId,
    request(AnalyticsMetrics.CHANNEL_VOLUME, range, MetricDimensions.CHANNEL)
  )
  const directory = useChannelDirectory(storeId)
  const rows = breakdownOf(volume.data)
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  // Channels with rows of zero are no share of anything: the same as no conversations
  const hasShares = total > 0
  const nameOf = (id: string): string =>
    directory.data?.find(channel => channel.pluginId === id)?.pluginName ?? id
  return (
    <section
      aria-labelledby="analytics-channels"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2 id="analytics-channels" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <PanelState isError={volume.isError} isPending={volume.data === undefined} />
      {volume.data === undefined ? null : !hasShares ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map(row => (
            <li key={row.id} className="flex flex-col gap-1 text-sm">
              <div className="flex justify-between gap-2">
                <span>{nameOf(row.id)}</span>
                <span className="tabular-nums">
                  {format.number(row.value / total, { style: 'percent', maximumFractionDigits: 0 })}
                  <span className="text-muted-foreground"> · {format.number(row.value)}</span>
                </span>
              </div>
              <div aria-hidden className="bg-muted h-2 overflow-hidden rounded-full">
                <div
                  className="bg-primary h-full"
                  style={{ width: `${(row.value / total) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// What each agent resolved and how fast they answered first. A person who is no longer in the team is named by what is left of them.
export function AgentPanel({ range }: { range: Range }): ReactElement {
  const t = useTranslations('analytics.agents')
  const format = useFormatter()
  const locale = useLocale()
  const { storeId } = useStore()
  const resolved = useMetrics(
    storeId,
    request(AnalyticsMetrics.CONVERSATIONS_PER_AGENT, range, MetricDimensions.AGENT)
  )
  const speed = useMetrics(
    storeId,
    request(AnalyticsMetrics.AGENT_FIRST_RESPONSE_TIME, range, MetricDimensions.AGENT)
  )
  const members = useMemberDirectory(storeId)
  const rows = breakdownOf(resolved.data)
  const speedOf = new Map(breakdownOf(speed.data).map(row => [row.id, row.value]))
  const nameOf = (id: string): string =>
    members.data === undefined
      ? t('unknownMember')
      : (members.data.find(member => member.id === id)?.name ?? t('formerMember'))
  return (
    <section
      aria-labelledby="analytics-agents"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2 id="analytics-agents" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <PanelState
        isError={resolved.isError || speed.isError}
        isPending={resolved.data === undefined || speed.data === undefined || members.isPending}
      />
      {resolved.data === undefined ||
      speed.data === undefined ||
      members.isPending ? null : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead>
            <tr className="text-muted-foreground text-left text-xs">
              <th scope="col" className="py-1 pr-2 font-medium">
                {t('agent')}
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                {t('resolved')}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t('firstResponse')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const seconds = speedOf.get(row.id)
              return (
                <tr key={row.id} className="border-t">
                  <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                    {nameOf(row.id)}
                  </th>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {format.number(row.value)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {seconds === undefined
                      ? t('noTime')
                      : (formatDuration(seconds, locale) ?? t('noTime'))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
