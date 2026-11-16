'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { FinanceTransactionView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { SelectField, TextField } from '../../components/finance/fields'
import { FinanceGate } from '../../components/finance/finance-gate'
import { TransactionDetailDialog } from '../../components/finance/transaction-detail-dialog'
import { TransactionFormDialog } from '../../components/finance/transaction-form-dialog'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { accountLabelsOf } from '../../lib/finance/account-form'
import { KINDS_IN_ORDER, permissionOfKind } from '../../lib/finance/transaction-form'
import {
  useFinanceAccounts,
  useFinanceTaxRates,
  useFinanceTransactions
} from '../../lib/finance/use-finance'
import { useMoney } from '../../lib/finance/use-money'

interface Filters {
  kind: string
  accountId: string
  from: string
  to: string
  includeVoided: boolean
}
const NO_FILTERS: Filters = { kind: '', accountId: '', from: '', to: '', includeVoided: false }

// Finance → Transactions (TDD_18 §4.3): the expenses, incomes and transfers registered by hand, the newest first, read by who holds
// `finance:view_journal`. Registering takes the permission of the kind (the bookkeeper's for an expense or an income, the one to move
// money for a transfer). A mistake is voided or replaced, never edited.
export function TransactionsPage(): ReactElement {
  return <FinanceGate>{settings => <Transactions rounding={settings.taxRounding} />}</FinanceGate>
}

function Transactions({ rounding }: { rounding: string }): ReactElement {
  const t = useTranslations('finance.transactions')
  const { storeId, can } = useStore()
  const allowed = can(ClientPermissions.FINANCE_VIEW_JOURNAL)
  const accounts = useFinanceAccounts(storeId, allowed)
  const rates = useFinanceTaxRates(storeId, allowed)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const transactions = useFinanceTransactions(storeId, filters, allowed)
  const [openId, setOpenId] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)
  if (!allowed) return <PermissionDenied permission={ClientPermissions.FINANCE_VIEW_JOURNAL} />
  if (transactions.isError && transactions.data === undefined) {
    return <LoadFailed error={transactions.error} onRetry={() => void transactions.refetch()} />
  }
  if (transactions.data === undefined || accounts.data === undefined || rates.data === undefined) {
    return <PageLoading />
  }
  const chart = accounts.data
  const rows = transactions.data.pages.flatMap(page => page.data)
  const filtered = Object.values(filters).some(value => value !== '' && value !== false)
  const set = (patch: Partial<Filters>): void => setFilters(current => ({ ...current, ...patch }))
  const label = accountLabelsOf(chart)
  const kinds = KINDS_IN_ORDER.filter(kind => can(permissionOfKind(kind)))

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {kinds.length > 0 ? (
          <Button size="sm" onClick={() => setRegistering(true)}>
            <Plus aria-hidden />
            {t('new')}
          </Button>
        ) : null}
      </header>
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t('filters.label')}
        onSubmit={event => event.preventDefault()}
      >
        <SelectField
          label={t('filters.kind')}
          value={filters.kind}
          onChange={kind => set({ kind })}
        >
          <option value="">{t('filters.allKinds')}</option>
          {KINDS_IN_ORDER.map(kind => (
            <option key={kind} value={kind}>
              {t(`kinds.${kind as 'expense'}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('filters.account')}
          value={filters.accountId}
          onChange={accountId => set({ accountId })}
        >
          <option value="">{t('filters.allAccounts')}</option>
          {[...chart]
            .sort((a, b) => a.code.localeCompare(b.code))
            .map(account => (
              <option key={account.id} value={account.id}>
                {label(account.id)}
              </option>
            ))}
        </SelectField>
        <TextField
          label={t('filters.from')}
          type="date"
          value={filters.from}
          onChange={from => set({ from })}
        />
        <TextField
          label={t('filters.to')}
          type="date"
          value={filters.to}
          onChange={to => set({ to })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.includeVoided}
            onChange={event => set({ includeVoided: event.target.checked })}
          />
          {t('filters.includeVoided')}
        </label>
        {filtered ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFilters(NO_FILTERS)}
            >
              {t('filters.clear')}
            </Button>
          </div>
        ) : null}
      </form>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filtered ? t('emptyFiltered') : t('empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="finance-transactions">
          {rows.map(transaction => (
            <TransactionRow
              key={transaction.id}
              transaction={transaction}
              onOpen={() => setOpenId(transaction.id)}
            />
          ))}
        </ul>
      )}
      {transactions.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={transactions.isFetchingNextPage}
            busy={transactions.isFetchingNextPage}
            onClick={() => void transactions.fetchNextPage()}
          >
            {t('loadMore')}
          </Button>
        </div>
      ) : null}
      {transactions.isFetchNextPageError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      ) : null}
      <TransactionDetailDialog
        transactionId={openId}
        accounts={chart}
        rates={rates.data}
        rounding={rounding}
        onOpenChange={open => {
          if (!open) setOpenId(null)
        }}
      />
      {kinds.length > 0 ? (
        <TransactionFormDialog
          replace={null}
          kinds={kinds}
          accounts={chart}
          rates={rates.data}
          rounding={rounding}
          open={registering}
          onOpenChange={setRegistering}
        />
      ) : null}
    </section>
  )
}

function TransactionRow({
  transaction,
  onOpen
}: {
  transaction: FinanceTransactionView
  onOpen: () => void
}): ReactElement {
  const t = useTranslations('finance.transactions')
  const money = useMoney()
  return (
    <li>
      <button
        type="button"
        data-testid="finance-transaction-row"
        data-kind={transaction.kind}
        data-voided={transaction.voided ? 'true' : 'false'}
        className="hover:bg-muted/50 flex w-full flex-col gap-1 px-4 py-3 text-left sm:flex-row sm:items-center sm:justify-between"
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{t(`kinds.${transaction.kind as 'expense'}`)}</span>
          <span className="text-muted-foreground truncate text-xs">
            {transaction.occurredOn} · {transaction.memo ?? t('row.noMemo')}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {transaction.voided ? (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('row.voided')}
            </span>
          ) : null}
          {transaction.replacesTransactionId === null ? null : (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('row.replaces')}
            </span>
          )}
          {transaction.documentMediaId === null ? null : (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('row.receipt')}
            </span>
          )}
          <span className="tabular-nums">{money(transaction.amountCents)}</span>
        </span>
      </button>
    </li>
  )
}
