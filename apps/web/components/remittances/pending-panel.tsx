'use client'

import { AlertTriangle } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { PendingConnectionView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { formatCents } from '../../lib/products/money'
import { isOverdue, pendingSummary } from '../../lib/remittances/remittance-rules'
import { useOverdueThreshold, useRemittancePending } from '../../lib/remittances/use-remittances'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'

function Shipments({ connectionId }: { connectionId: string }): ReactElement {
  const t = useTranslations('remittances.pending')
  const format = useFormatter()
  const { storeId } = useStore()
  const query = useRemittancePending(storeId, connectionId, true)
  if (query.isError) return <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
  if (query.data === undefined) return <PageLoading />
  const connection = query.data.find(entry => entry.connectionId === connectionId)
  if (connection === undefined || connection.shipments.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('noShipments')}</p>
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            {t('shipmentsCaption', { name: connection.connectionName })}
          </caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('columns.guide')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('columns.order')}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t('columns.expected')}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t('columns.remitted')}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t('columns.owed')}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t('columns.age')}
              </th>
            </tr>
          </thead>
          <tbody>
            {connection.shipments.map(shipment => (
              <tr key={shipment.shipmentId} className="border-b">
                <td className="py-1 pr-3 whitespace-nowrap">
                  {shipment.guideNumber ?? (
                    <span className="text-muted-foreground">{t('noGuide')}</span>
                  )}
                </td>
                <td className="py-1 pr-3 whitespace-nowrap">{shipment.orderNumber}</td>
                <td className="py-1 pr-3 text-right whitespace-nowrap">
                  {formatCents(format, shipment.expectedCents)}
                </td>
                <td className="py-1 pr-3 text-right whitespace-nowrap">
                  {shipment.remittedCents === null
                    ? ''
                    : formatCents(format, shipment.remittedCents)}
                </td>
                <td className="py-1 pr-3 text-right whitespace-nowrap">
                  {formatCents(format, shipment.owedCents)}
                </td>
                <td className="py-1 text-right whitespace-nowrap">
                  {shipment.ageDays === null ? '' : t('days', { count: shipment.ageDays })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {connection.truncated ? (
        <p className="text-muted-foreground text-sm">
          {t('truncated', { count: connection.shipments.length })}
        </p>
      ) : null}
    </div>
  )
}

function ConnectionRow({
  connection,
  threshold
}: {
  connection: PendingConnectionView
  threshold: number | null
}): ReactElement {
  const t = useTranslations('remittances.pending')
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const late = isOverdue(connection.oldestAgeDays, threshold)
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold">{connection.connectionName}</h3>
          <p className="text-muted-foreground text-sm">
            {t('shipmentCount', { count: connection.count })}
            {connection.oldestAgeDays === null
              ? ''
              : ` · ${t('oldest', { count: connection.oldestAgeDays })}`}
          </p>
          {late ? (
            <p className="text-destructive inline-flex items-center gap-1 text-sm" role="status">
              <AlertTriangle aria-hidden className="size-4" />
              {t('overdue', { days: threshold ?? 0 })}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-base font-semibold">
            <span className="text-muted-foreground mr-1 text-sm font-normal">{t('owed')}</span>
            {formatCents(format, connection.totalOwedCents)}
          </p>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-label={t(open ? 'hideShipmentsOf' : 'showShipmentsOf', {
              name: connection.connectionName
            })}
            onClick={() => setOpen(value => !value)}
          >
            {t(open ? 'hideShipments' : 'showShipments')}
          </Button>
        </div>
      </div>
      {open ? <Shipments connectionId={connection.connectionId} /> : null}
    </li>
  )
}

// What the carriers still owe (TDD_17 §4.15): per connection, the shipments waiting for a remittance, the total owed and how
// long the oldest has waited, with a warning past the days the store allows
export function PendingPanel(): ReactElement | null {
  const t = useTranslations('remittances.pending')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const canView = can(ClientPermissions.REMITTANCES_VIEW)
  const query = useRemittancePending(storeId, null, canView)
  const threshold = useOverdueThreshold(storeId, canView)
  if (query.isError) return <LoadFailed error={query.error} onRetry={() => void query.refetch()} />
  if (query.data === undefined) return <PageLoading />
  const summary = pendingSummary(query.data)
  return (
    <section aria-labelledby="remittances-pending-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="remittances-pending-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        {query.data.length > 0 ? (
          <p className="text-sm">
            {t('total', {
              amount: formatCents(format, summary.totalOwedCents),
              count: summary.count
            })}
          </p>
        ) : null}
      </div>
      {query.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {query.data.map(connection => (
            <ConnectionRow
              key={connection.connectionId}
              connection={connection}
              threshold={threshold}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
