'use client'

import { Clock, MailX, Undo2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useMemo, useState } from 'react'

import { DsrStatus, DsrType } from '@platform/core/domain'

import type { DsrRequestView } from '../../lib/compliance/dsr-requests'
import {
  attentionOf,
  canDownloadExport,
  daysOverdue,
  daysLeft,
  DEADLINE_ALERT_DAYS_LEFT,
  EMPTY_QUEUE_FILTER,
  filterRequests,
  isNoticeFailed,
  isOpenRequest,
  isOverdue,
  isReturned,
  type QueueFilter
} from '../../lib/compliance/dsr-view'
import { useDsrQueue } from '../../lib/compliance/use-dsr'
import type { Translate } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'

import { labelOf } from './dsr-labels'
import { DsrRequestDialog } from './dsr-request-dialog'
import { LoadFailed, PageLoading } from './states'

const STATUSES = Object.values(DsrStatus)
const TYPES = Object.values(DsrType)

// Settings → Store → Data requests: the review queue of the requests of people for their data (TDD_05 §10.2, Step 7.2-H2b-3). The whole
// queue is read (a store has few), so the banners and the marks count every request and never only the ones a filter shows. What needs
// a person is said at the top, in words and not only in colour: a request near its legal deadline, an approved erasure the sweep gave
// back, and above all a closing notice whose sending could not be confirmed (a right of the data subject).
export function DsrQueuePanel({ children }: { children?: ReactNode }): ReactElement {
  const t = useTranslations('settings.dataRequests')
  const { storeId } = useStore()
  const queue = useDsrQueue(storeId)
  const [filter, setFilter] = useState<QueueFilter>(EMPTY_QUEUE_FILTER)
  const [openId, setOpenId] = useState<string | null>(null)
  const rows = useMemo(() => queue.data?.pages.flatMap(page => page.data) ?? [], [queue.data])
  const now = new Date()
  const attention = attentionOf(rows, now)
  const shown = filterRequests(rows, filter)

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </header>

      {/* What sits under the page title and above the queue (the key of the public form): the h1 is the first heading of the page */}
      {children}

      {attention.noticeFailed.length > 0 ? (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/10 flex items-start gap-2 rounded-md border p-3 text-sm"
        >
          <MailX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              {t('banners.noticeFailed.title', { count: attention.noticeFailed.length })}
            </p>
            <p>{t('banners.noticeFailed.body')}</p>
          </div>
        </div>
      ) : null}
      {attention.deadline.length > 0 ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
        >
          <Clock aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              {t('banners.deadline.title', {
                count: attention.deadline.length,
                days: DEADLINE_ALERT_DAYS_LEFT
              })}
            </p>
            <p>{t('banners.deadline.body')}</p>
          </div>
        </div>
      ) : null}
      {attention.returned.length > 0 ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
        >
          <Undo2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">
              {t('banners.returned.title', { count: attention.returned.length })}
            </p>
            <p>{t('banners.returned.body')}</p>
          </div>
        </div>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t('filters.label')}
        onSubmit={event => event.preventDefault()}
      >
        <div className="flex min-w-44 flex-col gap-1">
          <Label htmlFor="dsr-filter-status">{t('filters.status')}</Label>
          <select
            id="dsr-filter-status"
            className={SELECT_CLASS}
            value={filter.status}
            onChange={event => setFilter({ ...filter, status: event.target.value })}
          >
            <option value="">{t('filters.anyStatus')}</option>
            {STATUSES.map(status => (
              <option key={status} value={status}>
                {t(`statuses.${status}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-44 flex-col gap-1">
          <Label htmlFor="dsr-filter-type">{t('filters.type')}</Label>
          <select
            id="dsr-filter-type"
            className={SELECT_CLASS}
            value={filter.type}
            onChange={event => setFilter({ ...filter, type: event.target.value })}
          >
            <option value="">{t('filters.anyType')}</option>
            {TYPES.map(type => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="outline" onClick={() => setFilter(EMPTY_QUEUE_FILTER)}>
          {t('filters.clear')}
        </Button>
      </form>

      {queue.isError && queue.data === undefined ? (
        <LoadFailed error={queue.error} onRetry={() => void queue.refetch()} />
      ) : queue.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">{t('empty')}</p>
      ) : (
        <>
          {shown.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">{t('emptyFiltered')}</p>
          ) : (
            <QueueTable rows={shown} now={now} onOpen={setOpenId} />
          )}
          {queue.isError ? (
            <LoadFailed error={queue.error} onRetry={() => void queue.fetchNextPage()} />
          ) : null}
          {queue.hasNextPage ? (
            <div className="flex flex-col items-center gap-2">
              <p role="status" className="text-muted-foreground text-xs">
                {t('partial', { count: rows.length })}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={queue.isFetchingNextPage}
                onClick={() => void queue.fetchNextPage()}
              >
                {t('loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {openId === null ? null : (
        <DsrRequestDialog key={openId} id={openId} onClose={() => setOpenId(null)} />
      )}
    </section>
  )
}

function QueueTable({
  rows,
  now,
  onOpen
}: {
  rows: readonly DsrRequestView[]
  now: Date
  onOpen: (id: string) => void
}): ReactElement {
  const t = useTranslations('settings.dataRequests')
  const tl = t as unknown as Translate
  const format = useFormatter()
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="text-muted-foreground border-b text-xs">
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.type')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.status')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.requested')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.deadline')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.marks')}
            </th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">{t('columns.details')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const left = daysLeft(row.deadlineAt, now)
            const type = labelOf(tl, 'types', row.type)
            return (
              <tr key={row.id} className="border-b align-top last:border-0">
                <td className="py-2 pr-3 font-medium">{type}</td>
                <td className="py-2 pr-3">{labelOf(tl, 'statuses', row.status)}</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {format.dateTime(new Date(row.requestedAt), { dateStyle: 'medium' })}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  {isOpenRequest(row)
                    ? isOverdue(row, now)
                      ? t('deadline.overdue', { count: daysOverdue(row.deadlineAt, now) })
                      : t('deadline.left', { count: left })
                    : row.status === String(DsrStatus.PENDING_VERIFICATION)
                      ? t('deadline.pending')
                      : t('deadline.none')}
                </td>
                <td className="py-2 pr-3">
                  <ul className="flex flex-col gap-0.5 text-xs">
                    {isNoticeFailed(row) ? (
                      <li className="text-destructive font-medium">{t('marks.noticeFailed')}</li>
                    ) : null}
                    {isReturned(row) ? <li>{t('marks.returned')}</li> : null}
                    {row.exportFailureCode !== null ? <li>{t('marks.exportFailed')}</li> : null}
                    {canDownloadExport(row, now) ? <li>{t('marks.exportReady')}</li> : null}
                    {row.status === String(DsrStatus.IN_PROGRESS) && row.erasureDueAt !== null ? (
                      <li>
                        {t('marks.erasesOn', {
                          date: format.dateTime(new Date(row.erasureDueAt), { dateStyle: 'medium' })
                        })}
                      </li>
                    ) : null}
                  </ul>
                </td>
                <td className="py-2 text-right">
                  <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(row.id)}>
                    {t('open')}
                    <span className="sr-only"> {type}</span>
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
