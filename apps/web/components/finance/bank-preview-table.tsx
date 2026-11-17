'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { BankPreviewView, BankRowErrorView } from '@platform/api-client'
import { BankStatementLimits } from '@platform/core/domain'

import { useMoney } from '../../lib/finance/use-money'

// What the api read of a sample (or of a refused file): the first lines as they would be imported, and every row it could not read, with
// the row, the column and the reason. The reasons are the closed list of the parser (`finance.reconciliation.errors.<code>`).
export function BankPreviewTable({ preview }: { preview: BankPreviewView }): ReactElement {
  const t = useTranslations('finance.reconciliation.preview')
  const money = useMoney()
  return (
    <div className="flex flex-col gap-2" data-testid="bank-preview">
      <p className="text-sm font-medium">
        {t('summary', { rows: preview.rowCount, shown: preview.lines.length })}
      </p>
      {preview.errorCount > 0 ? (
        <BankRowErrors errors={preview.errors} count={preview.errorCount} />
      ) : null}
      {preview.lines.length === 0 ? null : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="px-2 py-1 font-medium">{t('row')}</th>
                <th className="px-2 py-1 font-medium">{t('date')}</th>
                <th className="px-2 py-1 font-medium">{t('description')}</th>
                <th className="px-2 py-1 font-medium">{t('reference')}</th>
                <th className="px-2 py-1 text-right font-medium">{t('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {preview.lines.slice(0, BankStatementLimits.PREVIEW_ROWS).map(line => (
                <tr key={`${String(line.row)}-${String(line.occurrence)}`} className="border-t">
                  <td className="px-2 py-1">{line.row}</td>
                  <td className="px-2 py-1">
                    {line.postedTime === null
                      ? line.postedOn
                      : `${line.postedOn} ${line.postedTime}`}
                  </td>
                  <td className="px-2 py-1">{line.description ?? ''}</td>
                  <td className="px-2 py-1">{line.reference ?? ''}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{money(line.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// The rows a file was refused for (the first ones; the count of all of them is the api's). Text nodes only: a bad cell is shown as typed.
export function BankRowErrors({
  errors,
  count
}: {
  errors: readonly BankRowErrorView[]
  count: number
}): ReactElement {
  const t = useTranslations('finance.reconciliation.errors')
  const reason = (code: string): string =>
    t.has(code as 'empty_file') ? t(code as 'empty_file') : t('unknown')
  const field = (name: string | null): string =>
    name !== null && t.has(`fields.${name}` as 'fields.date')
      ? t(`fields.${name}` as 'fields.date')
      : ''
  // An error of the whole row (a stray quote) names no column: the text then has no empty slot, no loose comma
  const hasField = (name: string | null): 'yes' | 'no' => (field(name) === '' ? 'no' : 'yes')
  return (
    <div
      role="alert"
      className="text-destructive flex flex-col gap-1 text-sm"
      data-testid="bank-row-errors"
    >
      <p className="font-medium">{t('title', { count })}</p>
      <ul className="list-disc pl-5">
        {errors.map(error => (
          <li key={`${String(error.row)}-${error.field ?? ''}-${error.code}`}>
            {error.value === null
              ? t('row', {
                  row: error.row,
                  hasField: hasField(error.field),
                  field: field(error.field),
                  reason: reason(error.code)
                })
              : t('rowWithValue', {
                  row: error.row,
                  hasField: hasField(error.field),
                  field: field(error.field),
                  reason: reason(error.code),
                  value: error.value
                })}
          </li>
        ))}
      </ul>
      {count > errors.length ? <p>{t('more', { count: count - errors.length })}</p> : null}
    </div>
  )
}
