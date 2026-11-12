'use client'

import { Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { OrderSummaryView, ShipmentSummaryView } from '@platform/api-client'
import { OrderStatus, ShipmentStatus } from '@platform/core/domain'

import {
  type BulkReport,
  type BulkReportEntry,
  leftOutEntries,
  reportCounts
} from '../../lib/orders/order-bulk'
import { type Translate, useCodeText } from '../../lib/use-error-text'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

function isKnown<T extends string>(values: Record<string, T>, value: string): value is T {
  return Object.values(values).some(known => known === value)
}

// Why an order did not go through, in words: a rule of this page, a code of the api, or a closed word of the server (why a
// label is not in the file, why a pickup waits, why a message did not go). A word this page does not know draws "other".
function useReasonText(): (entry: BulkReportEntry) => string {
  const t = useTranslations('orders.bulk.report')
  const loose = t as unknown as Translate
  const codeText = useCodeText()
  return entry => {
    if (entry.rule !== undefined) return t(`rules.${entry.rule}`)
    if (entry.code !== undefined) return codeText(entry.code)
    if (entry.reason !== undefined) {
      const key = `reasons.${entry.reason}`
      return loose.has(key) ? loose(key) : t('reasons.unknown')
    }
    return ''
  }
}

function FinalState({
  entry,
  rows,
  guides
}: {
  entry: BulkReportEntry
  rows: ReadonlyMap<string, OrderSummaryView>
  guides: ReadonlyMap<string, ShipmentSummaryView[]>
}): ReactElement {
  const t = useTranslations('orders.bulk.report')
  const tBulk = useTranslations('orders.bulk')
  const tAll = useTranslations('orders')
  const row = rows.get(entry.orderId)
  const guide = guides.get(entry.orderId)?.[0]
  return (
    <>
      <td className="py-2 pr-3 text-sm">
        {row === undefined
          ? ''
          : isKnown(OrderStatus, row.status)
            ? tAll(`status.${row.status}`)
            : t('unknown')}
      </td>
      <td className="py-2 text-sm">
        {guide === undefined ? (
          <span className="text-muted-foreground">{t('noGuide')}</span>
        ) : isKnown(ShipmentStatus, guide.status) ? (
          tBulk(`shipmentStatus.${guide.status}`)
        ) : (
          t('unknown')
        )}
      </td>
    </>
  )
}

// What the action did, order by order: first the orders that did not go through, with the reason, and the final state of
// every order (read again after the action). The file of a run or a print is offered here while its link is good.
export function OrderBulkReport({
  report,
  failure,
  rows,
  guides,
  onClose
}: {
  report: BulkReport | null
  failure: string | null
  rows: ReadonlyMap<string, OrderSummaryView>
  guides: ReadonlyMap<string, ShipmentSummaryView[]>
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.bulk.report')
  const codeText = useCodeText()
  const reasonText = useReasonText()
  const open = report !== null || failure !== null
  const counts = report === null ? null : reportCounts(report)
  const left = report === null ? [] : leftOutEntries(report)
  const numberOf = (orderId: string): string => rows.get(orderId)?.orderNumber ?? orderId

  return (
    <Dialog open={open} onOpenChange={next => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {report === null ? t('failedTitle') : t(`title.${report.action}`)}
          </DialogTitle>
          <DialogDescription>
            {failure !== null
              ? codeText(failure)
              : counts === null
                ? ''
                : t('summary', {
                    done: counts.done + counts.reused,
                    left: counts.skipped + counts.failed
                  })}
          </DialogDescription>
        </DialogHeader>
        {report === null ? null : (
          <>
            {report.download === null ? null : (
              <Button asChild variant="outline" size="sm" className="self-start">
                <a href={report.download.url} target="_blank" rel="noreferrer">
                  <Download aria-hidden />
                  {t('openFile', { name: report.download.filename })}
                </a>
              </Button>
            )}
            {report.mixedSizes ? (
              <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                {t('mixedSizes')}
              </p>
            ) : null}
            {left.length === 0 ? (
              <p className="text-sm">{t('nothingLeftOut')}</p>
            ) : (
              <section aria-labelledby="orders-bulk-left-out" className="grid gap-2">
                <h3 id="orders-bulk-left-out" className="text-sm font-medium">
                  {t('leftOut', { count: left.length })}
                </h3>
                <ul className="grid gap-1 text-sm">
                  {left.map(entry => (
                    <li key={entry.orderId}>
                      <span className="font-medium">{numberOf(entry.orderId)}</span>
                      {': '}
                      {reasonText(entry) === '' ? t(`outcome.${entry.outcome}`) : reasonText(entry)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <caption className="sr-only">{t('tableCaption')}</caption>
                <thead>
                  <tr className="border-b text-sm">
                    <th className="py-2 pr-3 font-medium">{t('columns.order')}</th>
                    <th className="py-2 pr-3 font-medium">{t('columns.result')}</th>
                    <th className="py-2 pr-3 font-medium">{t('columns.orderStatus')}</th>
                    <th className="py-2 font-medium">{t('columns.guide')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.entries.map(entry => (
                    <tr key={entry.orderId} className="border-b align-top">
                      <td className="py-2 pr-3 text-sm whitespace-nowrap">
                        {numberOf(entry.orderId)}
                      </td>
                      <td className="py-2 pr-3 text-sm">{t(`outcome.${entry.outcome}`)}</td>
                      <FinalState entry={entry} rows={rows} guides={guides} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <DialogFooter>
          <Button onClick={onClose}>{t('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
