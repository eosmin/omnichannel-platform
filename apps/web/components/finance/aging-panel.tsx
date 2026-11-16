'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { AgingKind } from '@platform/core/domain'

import { agingQueryOf, dayFileName } from '../../lib/finance/statement-form'
import { accountRoleOf, bucketLabels, partyKeyOf } from '../../lib/finance/statement-view'
import { useDownloadAgingCsv, useFinanceAging } from '../../lib/finance/use-finance-statements'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { SelectField } from './fields'
import { Amount, ClosedThroughNote, CsvDownloadButton, ReportWarnings } from './report-parts'
import { DayFilters } from './statement-filters'

// The balances owed to the business or by it, by the age of each one (TDD_18 §10): the buckets are the upper bounds in days the api
// says it used, and an amount paid or received that no bill claims is its own column (it is not hidden inside a bucket). A role of the
// list with no account in the settings is said, and the list is not made up.
export function AgingPanel({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.aging')
  const tRoles = useTranslations('finance.settings.roles.names')
  const tParties = useTranslations('finance.aging.parties')
  const { storeId, can } = useStore()
  const [kind, setKind] = useState<AgingKind>(AgingKind.RECEIVABLES)
  const [asOf, setAsOf] = useState<string | null>(null)
  const query = asOf === null ? null : agingQueryOf(kind, asOf)
  const aging = useFinanceAging(storeId, query)
  const download = useDownloadAgingCsv(storeId)
  const data = aging.data
  return (
    <div className="flex flex-col gap-4" data-testid="finance-aging">
      <DayFilters
        onApply={day => {
          // The same question again is a new read: the books may have moved since
          if (day.asOf === asOf) void aging.refetch()
          setAsOf(day.asOf)
        }}
        extra={
          <SelectField
            label={t('kind')}
            value={kind}
            onChange={value => setKind(value as AgingKind)}
          >
            {Object.values(AgingKind).map(value => (
              <option key={value} value={value}>
                {t(`kinds.${value}`)}
              </option>
            ))}
          </SelectField>
        }
      >
        {query !== null && can(ClientPermissions.FINANCE_EXPORT) ? (
          <CsvDownloadButton
            label={t('download')}
            fileName={dayFileName(`${query.kind}-aging`, query.asOf)}
            query={query}
            run={input => download.mutateAsync(input)}
            isPending={download.isPending}
          />
        ) : null}
      </DayFilters>
      {query === null ? (
        <p className="text-muted-foreground text-sm">{t('pick')}</p>
      ) : aging.isError ? (
        <LoadFailed error={aging.error} onRetry={() => void aging.refetch()} />
      ) : data === undefined ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4">
          {data.missingRoles.length === 0 ? null : (
            <p
              role="alert"
              data-testid="finance-aging-missing-roles"
              className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm"
            >
              {t('missingRoles', {
                roles: data.missingRoles
                  .map(role => {
                    const known = accountRoleOf(role)
                    return known === null ? role : tRoles(known)
                  })
                  .join(', ')
              })}
            </p>
          )}
          <ClosedThroughNote lockedThrough={lockedThrough} lastDay={query.asOf} />
          <ReportWarnings warnings={data.warnings} />
          {/* Lines that carry no party are in the total and in no row: a list with no rows may still have something to say */}
          {data.rows.length === 0 && /^-?0+$/.test(data.totalCents) ? (
            <p className="text-muted-foreground text-sm">{t('none')}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[40rem] text-sm" data-testid="finance-aging-table">
                <thead>
                  <tr className="text-muted-foreground border-b text-xs">
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('party')}
                    </th>
                    {bucketLabels(data.bucketDays).map(bucket => (
                      <th
                        key={`${bucket.kind}-${String(bucket.from)}`}
                        scope="col"
                        className="px-3 py-2 text-end font-medium"
                      >
                        {bucket.kind === 'over'
                          ? t('bucketOver', { days: bucket.to })
                          : t('bucketRange', { from: bucket.from, to: bucket.to })}
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('unapplied')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('total')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.rows.map((row, index) => {
                    const partyKey = partyKeyOf(row.partyType)
                    return (
                      <tr
                        key={row.partyId ?? `none-${String(index)}`}
                        data-party={row.partyId ?? 'none'}
                      >
                        <th scope="row" className="px-3 py-2 text-start font-normal">
                          {row.partyName ?? t('noParty')}
                          {partyKey === null ? null : (
                            <span className="text-muted-foreground block text-xs">
                              {tParties(partyKey)}
                            </span>
                          )}
                        </th>
                        {row.bucketsCents.map((cents, bucketIndex) => (
                          <td key={bucketIndex} className="px-3 py-2 text-end">
                            <Amount cents={cents} />
                          </td>
                        ))}
                        <td className="px-3 py-2 text-end">
                          <Amount cents={row.unappliedCents} />
                        </td>
                        <td className="px-3 py-2 text-end font-medium">
                          <Amount cents={row.totalCents} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr
                    className="bg-muted/50 border-t font-semibold"
                    data-testid="finance-aging-total"
                  >
                    <th scope="row" className="px-3 py-2 text-start">
                      {t('totals')}
                    </th>
                    {data.bucketsCents.map((cents, bucketIndex) => (
                      <td key={bucketIndex} className="px-3 py-2 text-end">
                        <Amount cents={cents} />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-end">
                      <Amount cents={data.unappliedCents} />
                    </td>
                    <td className="px-3 py-2 text-end">
                      <Amount cents={data.totalCents} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
