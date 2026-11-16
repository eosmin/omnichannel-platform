'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { FinanceEntryView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { EntryOrigin, JournalEntryType } from '@platform/core/domain'

import { EntryDetailDialog } from '../../components/finance/entry-detail-dialog'
import { SelectField, TextField } from '../../components/finance/fields'
import { FinanceGate } from '../../components/finance/finance-gate'
import { ManualEntryDialog } from '../../components/finance/manual-entry-dialog'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { accountLabelsOf } from '../../lib/finance/account-form'
import { isCalendarDay } from '../../lib/finance/dates'
import { useFinanceAccounts, useFinanceEntries } from '../../lib/finance/use-finance'
import { useMoney } from '../../lib/finance/use-money'

const ENTRY_TYPES = Object.values(JournalEntryType)

interface Filters {
  type: string
  accountId: string
  from: string
  to: string
}
const NO_FILTERS: Filters = { type: '', accountId: '', from: '', to: '' }

// Finance → Journal (TDD_18 §4.2): every entry of the books, the newest first, read by who holds `finance:view_journal`. An entry is never
// edited or erased; who holds `finance:post_manual` writes one by hand and reverses one.
export function JournalPage(): ReactElement {
  return <FinanceGate>{() => <Journal />}</FinanceGate>
}

function Journal(): ReactElement {
  const t = useTranslations('finance.journal')
  const tTypes = useTranslations('finance.entryTypes')
  const { storeId, can } = useStore()
  const allowed = can(ClientPermissions.FINANCE_VIEW_JOURNAL)
  const accounts = useFinanceAccounts(storeId, allowed)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  // A date that is not a day is not asked of the api (it answers 400 and the page would be left on an error): it is no filter until it is one
  const entries = useFinanceEntries(
    storeId,
    {
      ...filters,
      from: isCalendarDay(filters.from) ? filters.from : '',
      to: isCalendarDay(filters.to) ? filters.to : ''
    },
    allowed
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  if (!allowed) return <PermissionDenied permission={ClientPermissions.FINANCE_VIEW_JOURNAL} />
  if (accounts.isError) {
    return <LoadFailed error={accounts.error} onRetry={() => void accounts.refetch()} />
  }
  if (accounts.data === undefined) return <PageLoading />
  const chart = accounts.data
  const rows = entries.data?.pages.flatMap(page => page.data) ?? []
  const filtered = Object.values(filters).some(value => value !== '')
  const set = (patch: Partial<Filters>): void => setFilters(current => ({ ...current, ...patch }))
  const label = accountLabelsOf(chart)

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {can(ClientPermissions.FINANCE_POST_MANUAL) ? (
          <Button size="sm" onClick={() => setWriting(true)}>
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
          label={t('filters.type')}
          value={filters.type}
          onChange={type => set({ type })}
        >
          <option value="">{t('filters.allTypes')}</option>
          {ENTRY_TYPES.map(type => (
            <option key={type} value={type}>
              {tTypes(type)}
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
      {entries.isError && entries.data === undefined ? (
        <LoadFailed error={entries.error} onRetry={() => void entries.refetch()} />
      ) : entries.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filtered ? t('emptyFiltered') : t('empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="finance-entries">
          {rows.map(entry => (
            <EntryRow key={entry.id} entry={entry} onOpen={() => setOpenId(entry.id)} />
          ))}
        </ul>
      )}
      {entries.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={entries.isFetchingNextPage}
            busy={entries.isFetchingNextPage}
            onClick={() => void entries.fetchNextPage()}
          >
            {t('loadMore')}
          </Button>
        </div>
      ) : null}
      {entries.isFetchNextPageError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      ) : null}
      <EntryDetailDialog
        entryId={openId}
        accounts={chart}
        onOpenChange={open => {
          if (!open) setOpenId(null)
        }}
      />
      {can(ClientPermissions.FINANCE_POST_MANUAL) ? (
        <ManualEntryDialog accounts={chart} open={writing} onOpenChange={setWriting} />
      ) : null}
    </section>
  )
}

function EntryRow({
  entry,
  onOpen
}: {
  entry: FinanceEntryView
  onOpen: () => void
}): ReactElement {
  const t = useTranslations('finance.journal.row')
  const tTypes = useTranslations('finance.entryTypes')
  const money = useMoney()
  return (
    <li>
      <button
        type="button"
        data-testid="finance-entry-row"
        data-number={entry.number}
        className="hover:bg-muted/50 flex w-full flex-col gap-1 px-4 py-3 text-left sm:flex-row sm:items-center sm:justify-between"
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">
            {t('number', { number: entry.number })} · {tTypes(entry.type as 'manual')}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {entry.entryDate} · {entry.memo ?? t('noMemo')}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {entry.reversedByEntryId === null ? null : (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('reversed')}
            </span>
          )}
          {entry.origin === String(EntryOrigin.SYSTEM) ? (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('automatic')}
            </span>
          ) : null}
          <span className="tabular-nums">{money(entry.totalCents)}</span>
        </span>
      </button>
    </li>
  )
}
