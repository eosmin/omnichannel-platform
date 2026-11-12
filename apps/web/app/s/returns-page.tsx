'use client'

import { ScanLine } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useMemo, useState } from 'react'

import { AppPaths, type ReturnView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { OrderReturnStatus, ReturnListLimits } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { ReturnStatusText } from '../../components/returns/return-badges'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { asReturnReasonKey } from '../../lib/orders/order-returns-rules'
import {
  asReturnsStatusFilter,
  EMPTY_RETURNS_FILTER,
  isReturnsFiltered,
  type ReturnsFilterDraft,
  returnsFilterProblems,
  ReturnsFilterProblems
} from '../../lib/returns/returns-filter'
import { useReturns } from '../../lib/returns/use-returns'

const NONE: readonly never[] = []

function unitsOf(entry: ReturnView): number {
  return entry.lines.reduce((sum, line) => sum + line.quantity, 0)
}

function Row({ entry }: { entry: ReturnView }): ReactElement {
  const t = useTranslations('returns.list')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId } = useStore()
  const made = new Date(entry.createdAt)
  const reason = asReturnReasonKey(entry.reason)
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        <Link
          href={AppPaths.store.return(storeId, entry.id)}
          className="underline-offset-2 hover:underline"
          aria-label={t('openReturn', { number: entry.orderNumber })}
        >
          {entry.orderNumber}
        </Link>
      </td>
      <td className="py-2 pr-3 text-sm">{tAll(`orders.detail.returns.type.${entry.type}`)}</td>
      <td className="py-2 pr-3 text-sm">
        {reason === null ? entry.reason : tAll(`orders.return.reason.${reason}`)}
      </td>
      <td className="py-2 pr-3 text-sm">
        <ReturnStatusText status={entry.status} />
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm whitespace-nowrap">
        {Number.isNaN(made.getTime()) ? '' : format.dateTime(made, { dateStyle: 'medium' })}
      </td>
      <td className="py-2 text-right text-sm whitespace-nowrap">
        {t('units', { count: unitsOf(entry) })}
      </td>
    </tr>
  )
}

function Filters({
  applied,
  onApply
}: {
  applied: ReturnsFilterDraft
  onApply: (next: ReturnsFilterDraft) => void
}): ReactElement {
  const t = useTranslations('returns.list')
  const tAll = useTranslations()
  const id = useId()
  const [draft, setDraft] = useState(applied)
  const problems = returnsFilterProblems(draft)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (problems.length === 0) onApply(draft)
  }
  const clear = (): void => {
    setDraft(EMPTY_RETURNS_FILTER)
    onApply(EMPTY_RETURNS_FILTER)
  }
  return (
    <form
      onSubmit={submit}
      aria-label={t('filtersLabel')}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-status`}>{t('filters.status')}</Label>
        <select
          id={`${id}-status`}
          className={SELECT_CLASS}
          value={draft.status ?? ''}
          onChange={event =>
            setDraft({ ...draft, status: asReturnsStatusFilter(event.target.value) })
          }
        >
          <option value="">{t('filters.anyStatus')}</option>
          {Object.values(OrderReturnStatus).map(value => (
            <option key={value} value={value}>
              {tAll(`orders.detail.returns.status.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-order`}>{t('filters.orderNumber')}</Label>
        <Input
          id={`${id}-order`}
          value={draft.orderNumber}
          maxLength={ReturnListLimits.ORDER_NUMBER_MAX_LENGTH + 1}
          aria-describedby={`${id}-order-hint`}
          onChange={event => setDraft({ ...draft, orderNumber: event.target.value })}
        />
        <span id={`${id}-order-hint`} className="text-muted-foreground text-xs">
          {t('filters.orderNumberHint')}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-from`}>{t('filters.from')}</Label>
        <Input
          id={`${id}-from`}
          type="date"
          value={draft.createdFrom}
          onChange={event => setDraft({ ...draft, createdFrom: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-to`}>{t('filters.to')}</Label>
        <Input
          id={`${id}-to`}
          type="date"
          value={draft.createdTo}
          onChange={event => setDraft({ ...draft, createdTo: event.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={problems.length > 0}>
          {t('filters.apply')}
        </Button>
        {isReturnsFiltered(applied) || isReturnsFiltered(draft) ? (
          <Button type="button" variant="outline" onClick={clear}>
            {t('filters.clear')}
          </Button>
        ) : null}
      </div>
      {problems.includes(ReturnsFilterProblems.RANGE_BACKWARDS) ? (
        <p role="alert" className="text-destructive w-full text-sm">
          {t('filters.rangeBackwards')}
        </p>
      ) : null}
      {problems.includes(ReturnsFilterProblems.ORDER_NUMBER_TOO_LONG) ? (
        <p role="alert" className="text-destructive w-full text-sm">
          {t('filters.orderNumberTooLong')}
        </p>
      ) : null}
    </form>
  )
}

// The returns of the store (TDD_17 §4.11): a table with filters by state, order number and day. Opening asks for returns:view; what
// changes a return is on its own page, and the reception of packages by scanner has its own.
export function ReturnsPage(): ReactElement {
  const t = useTranslations('returns.list')
  const { storeId, can } = useStore()
  const canView = can(ClientPermissions.RETURNS_VIEW)
  const [filter, setFilter] = useState(EMPTY_RETURNS_FILTER)
  const list = useReturns(storeId, filter, canView)
  const rows = useMemo(() => list.data?.pages.flatMap(page => page.data) ?? NONE, [list.data])
  if (!canView) return <PermissionDenied permission={ClientPermissions.RETURNS_VIEW} />
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('pageTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {can(ClientPermissions.RETURNS_MANAGE) ? (
          <Button asChild variant="outline">
            <Link href={AppPaths.store.returnsReception(storeId)}>
              <ScanLine aria-hidden className="size-4" />
              {t('receive')}
            </Link>
          </Button>
        ) : null}
      </header>
      <Filters applied={filter} onApply={setFilter} />
      {list.isError ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 && !list.isPlaceholderData ? (
        <p className="text-muted-foreground text-sm">
          {isReturnsFiltered(filter) ? t('emptyFiltered') : t('empty')}
        </p>
      ) : (
        <div
          className={list.isPlaceholderData ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}
          aria-busy={list.isPlaceholderData}
        >
          <table className="w-full text-left">
            <caption className="sr-only">{t('caption')}</caption>
            <thead>
              <tr className="border-b text-sm">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.order')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.type')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.reason')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.status')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('columns.created')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('columns.units')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(entry => (
                <Row key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && !list.isPlaceholderData ? (
        <Button
          variant="outline"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
