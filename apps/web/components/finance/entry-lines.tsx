'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FinanceAccountView, FinanceEntryLineView } from '@platform/api-client'

import { accountLabelsOf } from '../../lib/finance/account-form'
import { useMoney } from '../../lib/finance/use-money'

// The lines of an entry: the account, and the debit and the credit in dollars, with the total of each side under them
export function EntryLines({
  lines,
  accounts
}: {
  lines: readonly FinanceEntryLineView[]
  accounts: readonly FinanceAccountView[]
}): ReactElement {
  const t = useTranslations('finance.entry.lines')
  const money = useMoney()
  const label = accountLabelsOf(accounts)
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0)
  const credit = lines.reduce((sum, line) => sum + line.creditCents, 0)
  return (
    <table className="w-full text-sm" aria-label={t('label')} data-testid="finance-entry-lines">
      <thead>
        <tr className="text-muted-foreground text-left text-xs">
          <th className="py-1 pr-2 font-medium">{t('account')}</th>
          <th className="px-2 py-1 text-right font-medium">{t('debit')}</th>
          <th className="py-1 pl-2 text-right font-medium">{t('credit')}</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {lines.map(line => (
          <tr key={line.id} data-testid="finance-entry-line">
            <td className="py-1.5 pr-2 align-top break-words">
              {label(line.accountId)}
              {line.memo === null ? null : (
                <span className="text-muted-foreground block text-xs">{line.memo}</span>
              )}
            </td>
            <td className="px-2 py-1.5 text-right align-top tabular-nums">
              {line.debitCents > 0 ? money(line.debitCents) : ''}
            </td>
            <td className="py-1.5 pl-2 text-right align-top tabular-nums">
              {line.creditCents > 0 ? money(line.creditCents) : ''}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t font-medium">
          <td className="py-1.5 pr-2">{t('total')}</td>
          <td className="px-2 py-1.5 text-right tabular-nums">{money(debit)}</td>
          <td className="py-1.5 pl-2 text-right tabular-nums">{money(credit)}</td>
        </tr>
      </tfoot>
    </table>
  )
}
