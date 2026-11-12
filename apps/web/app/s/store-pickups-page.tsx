'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import type { PickupListFilter, PickupView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { PickupStatus } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { PickupFailureText, PickupStatusText } from '../../components/shipping/pickup-detail'
import { connectionsThatTakeRequests } from '../../components/shipping/pickup-request-dialog'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useConnectionViews, usePickupList } from '../../lib/shipping/use-shipping-screens'

import { LazyPickupDetail, LazyPickupRequest } from './lazy-shipping'

const ALL = ''
const NONE: readonly never[] = []

function Row({ pickup, onOpen }: { pickup: PickupView; onOpen: () => void }): ReactElement {
  const t = useTranslations('pickups.list')
  const format = useFormatter()
  const day = new Date(`${pickup.pickupDate}T00:00:00Z`)
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        {Number.isNaN(day.getTime())
          ? pickup.pickupDate
          : format.dateTime(day, { dateStyle: 'medium', timeZone: 'UTC' })}
      </td>
      <td className="py-2 pr-3 text-sm">{pickup.connectionName}</td>
      <td className="py-2 pr-3 text-sm">
        <PickupStatusText status={pickup.status} />
        {pickup.lastError === null ? null : (
          <span className="text-muted-foreground block text-xs">
            <PickupFailureText error={pickup.lastError} />
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-sm">{pickup.packageCount}</td>
      <td className="py-2 text-right">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpen}
          aria-label={t('openPickup', { carrier: pickup.connectionName, day: pickup.pickupDate })}
        >
          {t('open')}
        </Button>
      </td>
    </tr>
  )
}

// The pickups of the store (TDD_17 §4.10, §6): state and guides of each, the request, and what a person settles by hand
export function StorePickupsPage(): ReactElement {
  const t = useTranslations('pickups.list')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const canView = can(ClientPermissions.SHIPPING_VIEW)
  const canRequest = can(ClientPermissions.SHIPPING_MANAGE_PICKUPS)
  const [status, setStatus] = useState(ALL)
  const [connectionId, setConnectionId] = useState(ALL)
  const [from, setFrom] = useState(ALL)
  const [to, setTo] = useState(ALL)
  const [openPickup, setOpenPickup] = useState<PickupView | null>(null)
  const [isRequesting, setIsRequesting] = useState(false)
  const connections = useConnectionViews(storeId, canView)
  const filter = useMemo<PickupListFilter>(
    () => ({
      status: status === ALL ? undefined : status,
      connectionId: connectionId === ALL ? undefined : connectionId,
      from: from === ALL ? undefined : from,
      to: to === ALL ? undefined : to
    }),
    [status, connectionId, from, to]
  )
  const list = usePickupList(storeId, filter, canView)
  const rows = useMemo(() => list.data?.pages.flatMap(page => page.data) ?? NONE, [list.data])
  const isFiltered = Object.values(filter).some(value => value !== undefined)
  const requestable = connectionsThatTakeRequests(connections)
  // The pickup that is open is read from the list, so a change shows without closing the panel
  // A change can move it out of the filter (a cancelled pickup under "requested"): the panel keeps what the server last said
  const open = rows.find(pickup => pickup.id === openPickup?.id) ?? openPickup ?? undefined

  if (!canView) return <PermissionDenied permission={ClientPermissions.SHIPPING_VIEW} />
  return (
    <div className="flex flex-col gap-4 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {canRequest && requestable.length > 0 ? (
          <Button size="sm" onClick={() => setIsRequesting(true)}>
            {t('request')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pickups-status">{t('filters.status')}</Label>
          <select
            id="pickups-status"
            className={SELECT_CLASS}
            value={status}
            onChange={event => setStatus(event.target.value)}
          >
            <option value={ALL}>{t('filters.anyStatus')}</option>
            {Object.values(PickupStatus).map(value => (
              <option key={value} value={value}>
                {tAll(`pickups.status.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pickups-carrier">{t('filters.carrier')}</Label>
          <select
            id="pickups-carrier"
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
          <Label htmlFor="pickups-from">{t('filters.from')}</Label>
          <Input
            id="pickups-from"
            type="date"
            value={from}
            max={to === ALL ? undefined : to}
            onChange={event => setFrom(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pickups-to">{t('filters.to')}</Label>
          <Input
            id="pickups-to"
            type="date"
            value={to}
            min={from === ALL ? undefined : from}
            onChange={event => setTo(event.target.value)}
          />
        </div>
        {isFiltered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatus(ALL)
              setConnectionId(ALL)
              setFrom(ALL)
              setTo(ALL)
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
                <th className="py-2 pr-3 font-medium">{t('columns.day')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.carrier')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.status')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.packages')}</th>
                <th className="py-2">
                  <span className="sr-only">{t('columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(pickup => (
                <Row key={pickup.id} pickup={pickup} onOpen={() => setOpenPickup(pickup)} />
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
      {open === undefined ? null : (
        <LazyPickupDetail
          pickup={open}
          capabilities={
            connections.find(connection => connection.id === open.connectionId)?.capabilities ??
            null
          }
          onChanged={setOpenPickup}
          onClose={() => setOpenPickup(null)}
        />
      )}
      {isRequesting ? (
        <LazyPickupRequest connections={requestable} onClose={() => setIsRequesting(false)} />
      ) : null}
    </div>
  )
}
