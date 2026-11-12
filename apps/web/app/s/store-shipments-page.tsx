'use client'

import { X } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import { AppPaths, type ShipmentListFilter, type ShipmentRowView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { ShipmentStatus } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { ShipmentStatusText } from '../../components/shipping/shipment-status-text'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { dayRangeToMoments } from '../../lib/shipping/day-range'
import { useConnectionViews, useShipmentList } from '../../lib/shipping/use-shipping-screens'

import { LazyShipmentDetail } from './lazy-shipping'

const ALL = ''
const NONE: readonly never[] = []

function Row({
  shipment,
  onOpen
}: {
  shipment: ShipmentRowView
  onOpen: () => void
}): ReactElement {
  const t = useTranslations('shipments.list')
  const format = useFormatter()
  const { storeId } = useStore()
  const made = new Date(shipment.createdAt)
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        {shipment.guideNumber ?? <span className="text-muted-foreground">{t('guidePending')}</span>}
      </td>
      <td className="py-2 pr-3 text-sm">
        <ShipmentStatusText status={shipment.status} />
      </td>
      <td className="py-2 pr-3 text-sm">{shipment.connectionName}</td>
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        <Link
          href={AppPaths.store.order(storeId, shipment.orderId)}
          className="underline-offset-2 hover:underline"
        >
          {t('orderNumber', { number: shipment.orderNumber })}
        </Link>
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm whitespace-nowrap">
        {Number.isNaN(made.getTime()) ? '' : format.dateTime(made, { dateStyle: 'medium' })}
      </td>
      <td className="py-2 text-right">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpen}
          aria-label={t('openGuide', { guide: shipment.guideNumber ?? shipment.orderNumber })}
        >
          {t('open')}
        </Button>
      </td>
    </tr>
  )
}

// The guides of the store (TDD_17 §4.6, §6): filters by state, carrier, order and day, and the detail of each one
export function StoreShipmentsPage(): ReactElement {
  const t = useTranslations('shipments.list')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const canView = can(ClientPermissions.SHIPPING_VIEW)
  const [status, setStatus] = useState(ALL)
  const [connectionId, setConnectionId] = useState(ALL)
  // The order filter lives in the address, so a link to another order's guides changes it
  const orderId = params.get('orderId') ?? ALL
  const [from, setFrom] = useState(ALL)
  const [to, setTo] = useState(ALL)
  const [openId, setOpenId] = useState<string | null>(null)
  const connections = useConnectionViews(storeId, canView)
  const filter = useMemo<ShipmentListFilter>(() => {
    const range = dayRangeToMoments(from, to)
    return {
      status: status === ALL ? undefined : status,
      connectionId: connectionId === ALL ? undefined : connectionId,
      orderId: orderId === ALL ? undefined : orderId,
      from: range.from,
      to: range.to
    }
  }, [status, connectionId, orderId, from, to])
  const list = useShipmentList(storeId, filter, canView)
  const rows = useMemo(() => list.data?.pages.flatMap(page => page.data) ?? NONE, [list.data])
  const isFiltered = Object.values(filter).some(value => value !== undefined)
  const capabilitiesOf = (id: string): readonly string[] | null =>
    connections.find(connection => connection.id === id)?.capabilities ?? null

  if (!canView) return <PermissionDenied permission={ClientPermissions.SHIPPING_VIEW} />
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="shipments-status">{t('filters.status')}</Label>
          <select
            id="shipments-status"
            className={SELECT_CLASS}
            value={status}
            onChange={event => setStatus(event.target.value)}
          >
            <option value={ALL}>{t('filters.anyStatus')}</option>
            {Object.values(ShipmentStatus).map(value => (
              <option key={value} value={value}>
                {tAll(`orders.bulk.shipmentStatus.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="shipments-carrier">{t('filters.carrier')}</Label>
          <select
            id="shipments-carrier"
            className={SELECT_CLASS}
            value={connectionId}
            onChange={event => setConnectionId(event.target.value)}
          >
            <option value={ALL}>{t('filters.anyCarrier')}</option>
            {connections.map(connection => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="shipments-from">{t('filters.from')}</Label>
          <Input
            id="shipments-from"
            type="date"
            value={from}
            max={to === ALL ? undefined : to}
            onChange={event => setFrom(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="shipments-to">{t('filters.to')}</Label>
          <Input
            id="shipments-to"
            type="date"
            value={to}
            min={from === ALL ? undefined : from}
            onChange={event => setTo(event.target.value)}
          />
        </div>
        {orderId === ALL ? null : (
          <Button variant="outline" size="sm" onClick={() => router.replace(pathname)}>
            {t('filters.oneOrder')}
            <X aria-hidden />
            <span className="sr-only">{t('filters.removeOrder')}</span>
          </Button>
        )}
        {isFiltered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus(ALL)
              setConnectionId(ALL)
              setFrom(ALL)
              setTo(ALL)
              if (orderId !== ALL) router.replace(pathname)
            }}
          >
            {t('filters.clear')}
          </Button>
        ) : null}
      </div>
      {list.isPending ? <PageLoading /> : null}
      {list.isError && rows.length === 0 ? (
        <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{isFiltered ? t('noMatches') : t('empty')}</p>
      ) : null}
      {rows.length === 0 ? null : (
        <div
          className={list.isPlaceholderData ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}
          aria-busy={list.isPlaceholderData}
        >
          <table className="w-full text-left">
            <thead>
              <tr className="border-b text-sm">
                <th className="py-2 pr-3 font-medium">{t('columns.guide')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.status')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.carrier')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.order')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.created')}</th>
                <th className="py-2">
                  <span className="sr-only">{t('columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(shipment => (
                <Row key={shipment.id} shipment={shipment} onOpen={() => setOpenId(shipment.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          busy={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
      {openId === null ? null : (
        <LazyShipmentDetail
          shipmentId={openId}
          capabilitiesOf={capabilitiesOf}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
