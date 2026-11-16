'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { monthOf, monthProblem } from '../../lib/finance/bank-statement'
import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import { useBankStatus } from '../../lib/finance/use-finance-bank'
import { useMoney } from '../../lib/finance/use-money'
import { useStore } from '../providers/store-context'

import { TextField } from './fields'

// Where the reconciliation of the account stands in a month (TDD_18 §4.4): the lines of the books and of the statements of that month,
// how many have their pair and what the open ones add up to. A month is reconciled only when both sides have every line paired and there
// is at least one statement line: the api says so, the screen does not work it out.
export function BankStatusPanel({ accountId }: { accountId: string }): ReactElement {
  const t = useTranslations('finance.reconciliation.status')
  const errorText = useBankErrorText()
  const money = useMoney()
  const { storeId } = useStore()
  const [year, setYear] = useState(() => String(monthOf(new Date()).year))
  const [month, setMonth] = useState(() => String(monthOf(new Date()).month))
  const wrong = monthProblem(year, month)
  const status = useBankStatus(
    storeId,
    wrong === null ? { accountId, year: Number(year), month: Number(month) } : null
  )
  const sides =
    status.data === undefined
      ? []
      : ([
          { key: 'book', side: status.data.book },
          { key: 'statement', side: status.data.statement }
        ] as const)
  return (
    <section className="flex flex-col gap-3" aria-labelledby="bank-status-title">
      <div className="flex flex-col gap-1">
        <h2 id="bank-status-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </div>
      <div className="grid max-w-sm grid-cols-2 gap-3">
        <TextField
          label={t('month')}
          value={month}
          inputMode="numeric"
          maxLength={2}
          problem={wrong === 'month' ? t('problems.month') : null}
          onChange={setMonth}
        />
        <TextField
          label={t('year')}
          value={year}
          inputMode="numeric"
          maxLength={4}
          problem={wrong === 'year' ? t('problems.year') : null}
          onChange={setYear}
        />
      </div>
      {status.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(status.error)}
        </p>
      ) : null}
      {status.data === undefined ? null : (
        <div
          className="flex flex-col gap-2"
          data-testid="bank-status"
          data-reconciled={status.data.reconciled ? 'true' : 'false'}
        >
          <p className="text-sm font-medium" data-testid="bank-status-verdict">
            {status.data.reconciled ? t('reconciled') : t('open')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {sides.map(({ key, side }) => (
              <div key={key} className="flex flex-col gap-1 rounded-md border p-3" data-side={key}>
                <h3 className="text-sm font-semibold">{t(`sides.${key}`)}</h3>
                <p className="text-muted-foreground text-xs">
                  {t('counts', {
                    lines: side.lines,
                    matched: side.matched,
                    unmatched: side.unmatched
                  })}
                </p>
                <p className="text-sm tabular-nums">
                  {t('unmatchedAmount', { amount: money(side.unmatchedCents) })}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
