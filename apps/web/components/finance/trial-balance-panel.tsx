'use client'

import { Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { periodKeyOf } from '../../lib/finance/period-form'
import { trialBalanceFileName } from '../../lib/finance/report-form'
import { saveCsvFile } from '../../lib/finance/save-file'
import { useFinancePeriods } from '../../lib/finance/use-finance'
import {
  useDownloadTrialBalanceCsv,
  useFinanceTrialBalance
} from '../../lib/finance/use-finance-reports'
import { useMoney } from '../../lib/finance/use-money'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed } from '../settings/states'
import { Button } from '../ui/button'

import { SelectField } from './fields'

// The trial balance of one month (TDD_18 §10): every account with entries, what it was debited and credited, and its balance on the
// side where it normally sits. The totals say whether the month balances: a month that does not is shown as it is, never hidden.
export function TrialBalancePanel(): ReactElement {
  const t = useTranslations('finance.reports.trialBalance')
  const typeLabel = useTranslations('finance.accounts.types')
  const money = useMoney()
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const periods = useFinancePeriods(storeId, true)
  const [chosen, setChosen] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const download = useDownloadTrialBalanceCsv(storeId)
  const guard = useSubmitGuard()
  // The newest month unless the person chose another one
  const sorted = [...(periods.data ?? [])].sort((a, b) =>
    periodKeyOf(b).localeCompare(periodKeyOf(a))
  )
  // The month the person chose, else the newest that has started (a month opened ahead of time has nothing in it yet)
  // The api says whether it has started, in the day the books are kept in: the browser clock decides nothing
  const period =
    sorted.find(item => item.id === chosen) ?? sorted.find(item => item.hasStarted) ?? sorted[0]
  const report = useFinanceTrialBalance(storeId, period?.id ?? null, true)

  if (periods.isError) {
    return <LoadFailed error={periods.error} onRetry={() => void periods.refetch()} />
  }
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="finance-trial-balance-title"
      data-testid="finance-trial-balance"
    >
      <header className="flex flex-col gap-1">
        <h2 id="finance-trial-balance-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      {period === undefined ? (
        <p className="text-muted-foreground text-sm">
          {periods.data === undefined ? t('loading') : t('noPeriods')}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-64">
              <SelectField
                label={t('period')}
                value={period.id}
                onChange={next => {
                  setChosen(next)
                  setRefusal(null)
                }}
              >
                {sorted.map(item => (
                  <option key={item.id} value={item.id}>
                    {periodKeyOf(item)}
                  </option>
                ))}
              </SelectField>
            </div>
            {can(ClientPermissions.FINANCE_EXPORT) ? (
              <Button
                variant="outline"
                size="sm"
                disabled={download.isPending}
                busy={download.isPending}
                onClick={() => {
                  if (!guard.enter()) return
                  setRefusal(null)
                  const name = trialBalanceFileName(period)
                  download.mutate(period.id, {
                    onSuccess: text => saveCsvFile(name, text),
                    onError: error => setRefusal(errorText(error)),
                    onSettled: guard.leave
                  })
                }}
              >
                <Download aria-hidden />
                {t('download')}
              </Button>
            ) : null}
          </div>
          {refusal === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {refusal}
            </p>
          )}
          {report.isError ? (
            <LoadFailed error={report.error} onRetry={() => void report.refetch()} />
          ) : report.data === undefined ? (
            <p className="text-muted-foreground text-sm">{t('loading')}</p>
          ) : report.data.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[34rem] text-sm">
                <caption className="sr-only">
                  {t('caption', { period: periodKeyOf(period) })}
                </caption>
                <thead>
                  <tr className="text-muted-foreground border-b text-left">
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.account')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('columns.type')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('columns.debit')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('columns.credit')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('columns.balance')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.rows.map(row => (
                    <tr
                      key={row.accountId}
                      className="border-b last:border-b-0"
                      data-testid="finance-trial-balance-row"
                    >
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs">{row.code}</span> {row.name}
                      </td>
                      <td className="px-3 py-2">
                        {typeLabel.has(row.type as 'asset')
                          ? typeLabel(row.type as 'asset')
                          : row.type}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(row.debitCents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(row.creditCents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(row.balanceCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-medium">
                    <th scope="row" colSpan={2} className="px-3 py-2 text-left">
                      {t('totals')}
                    </th>
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      data-testid="finance-trial-balance-debit"
                    >
                      {money(report.data.totals.debitCents)}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      data-testid="finance-trial-balance-credit"
                    >
                      {money(report.data.totals.creditCents)}
                    </td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {report.data === undefined ? null : (
            <p
              role={report.data.totals.balanced ? 'status' : 'alert'}
              className={
                report.data.totals.balanced ? 'text-sm' : 'text-destructive text-sm font-medium'
              }
              data-testid="finance-trial-balance-verdict"
            >
              {report.data.totals.balanced ? t('balanced') : t('unbalanced')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
