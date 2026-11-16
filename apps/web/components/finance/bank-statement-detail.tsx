'use client'

import { CheckCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { BankImportView, BankLineView, FinanceAccountView } from '@platform/api-client'
import { BankLineFilters, BankStatementLimits } from '@platform/core/domain'

import { LINE_FILTERS } from '../../lib/finance/bank-statement'
import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import {
  useBankDifference,
  useBankLines,
  useConfirmExactBankLines
} from '../../lib/finance/use-finance-bank'
import { useMoney } from '../../lib/finance/use-money'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'

import { BankConfirmDialog } from './bank-confirm-dialog'
import { BankLineRow } from './bank-line-row'
import { BankRegisterDraftDialog } from './bank-register-draft-dialog'

// One imported statement (TDD_18 §4.4): the balance of the books against the one the statement ends with, the lines in the order of the
// file with what the rules suggest for each, and the decisions. Every decision is the person's; the bulk one asks first.
export function BankStatementDetail({
  statement,
  accounts
}: {
  statement: BankImportView
  accounts: readonly FinanceAccountView[]
}): ReactElement {
  const t = useTranslations('finance.reconciliation.statement')
  const errorText = useBankErrorText()
  const { storeId } = useStore()
  const [filter, setFilter] = useState<string>(LINE_FILTERS[0])
  // The pages already left, so "previous" goes back to the one before without asking the api for a cursor it never gave
  const [cursors, setCursors] = useState<(number | null)[]>([null])
  const after = cursors[cursors.length - 1] ?? null
  const lines = useBankLines(storeId, statement.id, filter, after)
  const confirmAll = useConfirmExactBankLines(storeId)
  const [asking, setAsking] = useState(false)
  const [registering, setRegistering] = useState<BankLineView | null>(null)

  // A failed read in the background leaves the lines that were there; only a screen with nothing to show says it failed
  if (lines.data === undefined) {
    return lines.isError ? (
      <LoadFailed error={lines.error} onRetry={() => void lines.refetch()} />
    ) : (
      <PageLoading />
    )
  }
  const { counts } = lines.data

  const choose = (next: string): void => {
    setFilter(next)
    setCursors([null])
  }

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="bank-statement-title"
      data-testid="bank-statement"
      data-import={statement.id}
    >
      <header className="flex flex-col gap-1">
        <h2 id="bank-statement-title" className="text-lg font-semibold">
          {t('title', { from: statement.firstDay, to: statement.lastDay })}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t('summary', { lines: statement.lineCount, added: statement.newLineCount })}
        </p>
      </header>

      {statement.closingBalanceCents === null ? (
        <p className="text-muted-foreground text-sm" data-testid="bank-no-closing">
          {t('noClosing')}
        </p>
      ) : (
        <BankDifference statement={statement} />
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label={t('filterLabel')} className="flex flex-wrap gap-2">
          {LINE_FILTERS.map(option => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={filter === option ? 'default' : 'outline'}
              aria-pressed={filter === option}
              data-testid={`bank-filter-${option}`}
              onClick={() => choose(option)}
            >
              {t(`filters.${option}`, {
                count: counts[option === BankLineFilters.ALL ? 'total' : option]
              })}
            </Button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={counts.suggested === 0 || confirmAll.isPending}
          onClick={() => setAsking(true)}
          data-testid="bank-confirm-exact"
        >
          <CheckCheck aria-hidden />
          {t('confirmExact')}
        </Button>
      </div>

      {lines.data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="bank-lines-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="bank-lines">
          {lines.data.items.map(line => (
            <BankLineRow key={line.id} line={line} onRegister={setRegistering} />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={cursors.length === 1 || lines.isPlaceholderData}
          onClick={() => setCursors(current => current.slice(0, -1))}
        >
          {t('previous')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={lines.data.next === null || lines.isPlaceholderData}
          onClick={() => {
            const next = lines.data?.next
            if (next !== undefined && next !== null) setCursors(current => [...current, next])
          }}
        >
          {t('next')}
        </Button>
      </div>

      <BankConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('confirmExactTitle')}
        description={t('confirmExactDescription', { max: BankStatementLimits.MAX_BULK_CONFIRM })}
        confirmLabel={t('confirmExactAction')}
        busy={confirmAll.isPending}
        onConfirm={() =>
          confirmAll.mutate(statement.id, {
            onSuccess: result => {
              toast.success(
                t('confirmExactDone', { confirmed: result.confirmed, left: result.left })
              )
              setAsking(false)
            },
            onError: error => {
              toast.error(errorText(error))
              setAsking(false)
            }
          })
        }
      />
      <BankRegisterDraftDialog
        line={registering}
        accounts={accounts}
        onOpenChange={open => {
          if (!open) setRegistering(null)
        }}
      />
    </section>
  )
}

// The balance the books have at the day of the statement against the one the statement ends with, and what the lines still open explain
function BankDifference({ statement }: { statement: BankImportView }): ReactElement | null {
  const t = useTranslations('finance.reconciliation.difference')
  const errorText = useBankErrorText()
  const money = useMoney()
  const { storeId } = useStore()
  const difference = useBankDifference(storeId, statement.id, true)
  if (difference.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {errorText(difference.error)}
      </p>
    )
  }
  if (difference.data === undefined) return null
  const data = difference.data
  const rows: [string, string][] = [
    [t('statementBalance', { date: data.closingOn }), money(data.statementBalanceCents)],
    [t('bookBalance'), money(data.bookBalanceCents)],
    [t('difference'), money(data.differenceCents)],
    [
      t('unmatchedStatement', { count: data.unmatchedStatement.lines }),
      money(data.unmatchedStatement.cents)
    ],
    [t('unmatchedBook', { count: data.unmatchedBook.lines }), money(data.unmatchedBook.cents)],
    [t('unexplained'), money(data.unexplainedCents)]
  ]
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="bank-difference">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        {rows.flatMap(([label, value]) => [
          <dt key={`${label}-t`} className="text-muted-foreground">
            {label}
          </dt>,
          <dd key={`${label}-d`} className="text-right tabular-nums">
            {value}
          </dd>
        ])}
      </dl>
      <p className="text-muted-foreground text-xs">
        {data.unexplainedCents === 0 ? t('explained') : t('unexplainedHint')}
      </p>
    </div>
  )
}
