'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { useSearchReport } from '../../lib/analytics/use-analytics-data'
import { useStore } from '../providers/store-context'

// What was searched in the store (TDD_08 §5.6): how many searches of each kind, how many found nothing, how many ended in a
// result that was opened, and the texts of the catalog nobody found. Only the catalog keeps the text of a search that found
// nothing; what was asked of people, conversations, orders or the whole store is only counted.
export function SearchPanel({ days }: { days: number }): ReactElement {
  const t = useTranslations('analytics.searches')
  const format = useFormatter()
  const { storeId } = useStore()
  const report = useSearchReport(storeId, days)
  const data = report.data
  const searched = data?.scopes.some(row => row.searches + row.clicks > 0) ?? false
  return (
    <section
      aria-labelledby="analytics-searches"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="analytics-searches" className="text-sm font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-xs">{t('note', { days })}</p>
      </div>
      {report.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('failed')}
        </p>
      ) : data === undefined ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      ) : !searched && data.zeroResultQueries.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('caption')}</caption>
            <thead>
              <tr className="text-muted-foreground text-left text-xs">
                <th scope="col" className="py-1 pr-2 font-medium">
                  {t('scope')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  {t('searches')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  {t('zeroResults')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('clicks')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.scopes.map(row => (
                <tr key={row.scope} className="border-t">
                  <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                    {t(`scopes.${row.scope}`)}
                  </th>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {format.number(row.searches)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {format.number(row.zeroResults)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{format.number(row.clicks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium">{t('gaps.title')}</h3>
            {data.zeroResultQueries.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('gaps.empty')}</p>
            ) : (
              <ul className="flex flex-col divide-y text-sm">
                {data.zeroResultQueries.map((row, index) => (
                  <li
                    key={`${index}-${row.query}`}
                    className="flex items-baseline justify-between gap-3 py-1.5"
                  >
                    {/* The text is a customer's own: a text node, never markup */}
                    <span className="min-w-0 truncate">{row.query}</span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {t('gaps.times', { count: row.occurrences })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
