'use client'

import { Download, Plus, Search, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useMemo, useState } from 'react'

import {
  AppPaths,
  type OrderListFilter,
  type OrderSummaryView,
  type ShipmentSummaryView
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  OrderGuideFilters,
  OrderLimits,
  OrderScheduledDeliveryShortcuts,
  OrderSorts,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PriceApprovalStatus,
  ShipmentStatus
} from '@platform/core/domain'

import { CautionChip } from '../../components/customers/caution-chip'
import { useCustomerDrawer } from '../../components/customers/customer-drawer-context'
import { MutationError } from '../../components/customers/mutation-error'
import { OrderBulkPanel } from '../../components/orders/lazy-bulk'
import { useOrderDrawer } from '../../components/orders/order-drawer-context'
import { useStore } from '../../components/providers/store-context'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import type { BulkConnection } from '../../lib/orders/order-bulk'
import {
  activeFilterCount,
  withScheduledDays,
  withScheduledShortcut
} from '../../lib/orders/order-filters'
import { liveGuidesByOrder } from '../../lib/orders/order-guides'
import {
  keepShown,
  NO_SELECTION,
  type OrderSelection,
  toggleAll,
  toggleOrder
} from '../../lib/orders/order-selection'
import { useOrderFilters } from '../../lib/orders/use-order-filters'
import { useCarrierConnections, useOrderShipments } from '../../lib/orders/use-order-shipping'
import { useExportOrders, useOrderList } from '../../lib/orders/use-orders'
import { formatCents } from '../../lib/products/money'
import { toast } from '../../lib/toast'
import { useDebouncedValue } from '../../lib/use-debounced-value'

const SEARCH_DELAY_MS = 300
const CHECKBOX_CLASS = 'size-4 accent-current pointer-coarse:size-5'

// A day of the store ('YYYY-MM-DD') as text: built at UTC and written at UTC, so the day never moves with the zone of the
// person (it is a calendar day, not a moment)
function useDayText(): (day: string) => string {
  const format = useFormatter()
  return day =>
    format.dateTime(new Date(`${day}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
}

// A value of a server newer than this page is not one of ours: it draws under "unknown" and not as an empty cell
function isKnown<T extends string>(values: Record<string, T>, value: string): value is T {
  return Object.values(values).some(known => known === value)
}

function StatusBadge({ order }: { order: OrderSummaryView }): ReactElement {
  const t = useTranslations('orders')
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="rounded border px-1.5 py-0.5 text-xs font-medium">
        {isKnown(OrderStatus, order.status) ? t(`status.${order.status}`) : t('list.unknownStatus')}
      </span>
      {isKnown(PriceApprovalStatus, order.priceApprovalStatus) &&
      order.priceApprovalStatus === PriceApprovalStatus.PENDING ? (
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {t('list.awaitingPriceApproval')}
        </span>
      ) : null}
    </div>
  )
}

function PaymentCell({ order }: { order: OrderSummaryView }): ReactElement {
  const t = useTranslations('orders')
  return (
    <>
      <p>
        {isKnown(PaymentStatus, order.paymentStatus)
          ? t(`paymentStatus.${order.paymentStatus}`)
          : t('list.unknownPayment')}
      </p>
      <p className="text-muted-foreground text-xs">
        {isKnown(PaymentMethod, order.paymentMethod)
          ? t(`paymentMethod.${order.paymentMethod}`)
          : t('list.unknownPayment')}
      </p>
    </>
  )
}

// The carrier the order is planned for, its live guide and the state of that guide: columns of who may view shipping
function ShippingCells({
  order,
  connections,
  guides
}: {
  order: OrderSummaryView
  connections: readonly BulkConnection[]
  guides: readonly ShipmentSummaryView[]
}): ReactElement {
  const t = useTranslations('orders.list')
  const tBulk = useTranslations('orders.bulk')
  const guide = guides[0]
  const planned = connections.find(connection => connection.id === order.carrierConnectionId)
  return (
    <>
      <td className="py-2 pr-3 text-sm">
        {guide !== undefined ? (
          guide.connectionName
        ) : planned !== undefined ? (
          planned.displayName
        ) : (
          <span className="text-muted-foreground">{t('noCarrier')}</span>
        )}
      </td>
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        {guide === undefined ? (
          <span className="text-muted-foreground">{t('noGuide')}</span>
        ) : guide.guideNumber === null ? (
          <span className="text-muted-foreground">{t('guidePending')}</span>
        ) : guide.trackingUrl === null ? (
          guide.guideNumber
        ) : (
          <a
            href={guide.trackingUrl}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {guide.guideNumber}
          </a>
        )}
      </td>
      <td className="py-2 pr-3 text-sm">
        {guide === undefined
          ? null
          : isKnown(ShipmentStatus, guide.status)
            ? tBulk(`shipmentStatus.${guide.status}`)
            : t('unknownStatus')}
      </td>
    </>
  )
}

function Row({
  order,
  isSelected,
  onToggle,
  shipping
}: {
  order: OrderSummaryView
  isSelected: boolean
  onToggle: () => void
  shipping: {
    connections: readonly BulkConnection[]
    guides: readonly ShipmentSummaryView[]
  } | null
}): ReactElement {
  const t = useTranslations('orders.list')
  const format = useFormatter()
  const dayText = useDayText()
  const { storeId, can } = useStore()
  const { openCustomer } = useCustomerDrawer()
  const made = new Date(order.createdAt)
  const name = order.customer.name ?? t('unnamedCustomer')
  return (
    <tr className="border-b align-top" aria-selected={isSelected}>
      <td className="py-2 pr-3">
        <input
          type="checkbox"
          className={CHECKBOX_CLASS}
          checked={isSelected}
          onChange={onToggle}
          aria-label={t('selectOrder', { number: order.orderNumber })}
        />
      </td>
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        <Link
          href={AppPaths.store.order(storeId, order.id)}
          className="font-medium underline-offset-2 hover:underline"
        >
          {t('number', { number: order.orderNumber })}
        </Link>
        {order.priceModified ? (
          <span className="text-muted-foreground block text-xs">{t('priceModified')}</span>
        ) : null}
      </td>
      <td className="py-2 pr-3 text-sm">
        {can(ClientPermissions.CUSTOMERS_VIEW) ? (
          <Button
            variant="ghost"
            className="h-auto max-w-full justify-start px-1 py-0.5 font-medium"
            onClick={() => openCustomer(order.customer.id)}
          >
            <span className="truncate">{name}</span>
          </Button>
        ) : (
          <span>{name}</span>
        )}
        {order.customer.isCaution ? (
          <span className="mt-1 block">
            <CautionChip />
          </span>
        ) : null}
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm whitespace-nowrap">
        {Number.isNaN(made.getTime()) ? '' : format.dateTime(made, { dateStyle: 'medium' })}
      </td>
      <td className="py-2 pr-3 text-sm">
        <StatusBadge order={order} />
      </td>
      <td className="py-2 pr-3 text-sm">
        <PaymentCell order={order} />
      </td>
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        {order.scheduledDeliveryDate === null ? (
          <span className="text-muted-foreground">{t('noSchedule')}</span>
        ) : (
          dayText(order.scheduledDeliveryDate)
        )}
      </td>
      {shipping === null ? null : (
        <ShippingCells order={order} connections={shipping.connections} guides={shipping.guides} />
      )}
      <td className="py-2 text-right text-sm whitespace-nowrap tabular-nums">
        {formatCents(format, order.totalCents)}
      </td>
    </tr>
  )
}

// The orders of the store (TDD_09 §5): a table with the search by number or customer, the filters of the api, a page at a
// time (cursor), all of it kept in the address so that a list can be shared and the back button returns to it. The rows
// can be ticked: the bulk actions of Step 4.14 act on that selection. Each number opens the order.
export function OrdersPage(): ReactElement {
  const t = useTranslations('orders.list')
  const tAll = useTranslations()
  const router = useRouter()
  const { storeId, can } = useStore()
  const mayView = can(ClientPermissions.ORDERS_VIEW)
  const { state, setState } = useOrderFilters()
  const { filter, sort } = state
  const [text, setText] = useState(filter.q ?? '')
  const typed = text.trim()
  const debounced = useDebouncedValue(typed, SEARCH_DELAY_MS)
  const [selection, setSelection] = useState<OrderSelection>(NO_SELECTION)
  const orders = useOrderList(storeId, filter, sort, mayView)
  const exportCsv = useExportOrders(storeId)
  const { openCreate } = useOrderDrawer()
  const rows = useMemo(() => orders.data?.pages.flatMap(page => page.data) ?? [], [orders.data])

  // The search goes to the address once the person stops typing: the box and the address never fight, because a text that
  // has not settled is not written (clearing the filters empties the box first)
  useEffect(() => {
    if (debounced === typed && debounced !== (filter.q ?? '')) {
      setState({ filter: { ...filter, q: debounced === '' ? undefined : debounced }, sort })
    }
  }, [debounced, typed, filter, sort, setState])

  // Only rows still on the screen stay ticked
  const shownIds = useMemo(() => rows.map(row => row.id), [rows])
  // Shipping is read for who may view it: the carrier, guide and shipment columns, the carrier filter and the actions that
  // start from a guide are not there for anyone else
  const canShip = can(ClientPermissions.SHIPPING_VIEW)
  const connections = useCarrierConnections(storeId, canShip)
  const shipments = useOrderShipments(storeId, shownIds, canShip)
  const guides = useMemo(() => liveGuidesByOrder(shipments), [shipments])
  const rowsById = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows])
  const selectedIds = useMemo(() => [...selection], [selection])
  useEffect(() => {
    setSelection(current => keepShown(current, shownIds))
  }, [shownIds])

  if (!mayView) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm">
          {t('noAccess')}
        </p>
      </div>
    )
  }

  const change = (next: OrderListFilter): void => setState({ filter: next, sort })
  const count = activeFilterCount(filter)
  const isFiltered = count > 0
  const everyShownIsTicked = rows.length > 0 && rows.every(row => selection.has(row.id))
  const customerName =
    filter.customerId === undefined
      ? null
      : (rows.find(row => row.customer.id === filter.customerId)?.customer.name ??
        t('filters.aCustomer'))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">{t('title')}</h1>
        {can(ClientPermissions.ORDERS_CREATE) ? (
          <Button size="sm" onClick={() => openCreate()}>
            <Plus aria-hidden />
            {t('newOrder')}
          </Button>
        ) : null}
        {can(ClientPermissions.ORDERS_EXPORT) ? (
          <Button
            variant="outline"
            size="sm"
            disabled={exportCsv.isPending}
            onClick={() => {
              // The filters of the address, not the text still being typed; mutateAsync so the toast also appears when
              // the person has already left the page
              exportCsv
                .mutateAsync(filter)
                .then(() =>
                  toast.success(t('exportQueued'), {
                    action: {
                      label: t('viewExports'),
                      onClick: () => router.push(AppPaths.store.exports(storeId))
                    }
                  })
                )
                .catch(() => undefined) // the error is drawn by MutationError
            }}
          >
            <Download aria-hidden />
            {t('export')}
          </Button>
        ) : null}
      </div>
      <MutationError error={exportCsv.error} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-md">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4"
          />
          <Input
            type="search"
            className="pl-8"
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            maxLength={OrderLimits.SEARCH_MAX_LENGTH}
            value={text}
            onChange={event => setText(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="orders-status" className="text-xs">
            {t('filters.status')}
          </Label>
          <select
            id="orders-status"
            className={SELECT_CLASS}
            value={filter.status ?? ''}
            onChange={event =>
              change({
                ...filter,
                status: event.target.value === '' ? undefined : event.target.value
              })
            }
          >
            <option value="">{t('filters.allStatuses')}</option>
            {Object.values(OrderStatus).map(status => (
              <option key={status} value={status}>
                {tAll(`orders.status.${status}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="orders-payment" className="text-xs">
            {t('filters.paymentStatus')}
          </Label>
          <select
            id="orders-payment"
            className={SELECT_CLASS}
            value={filter.paymentStatus ?? ''}
            onChange={event =>
              change({
                ...filter,
                paymentStatus: event.target.value === '' ? undefined : event.target.value
              })
            }
          >
            <option value="">{t('filters.allPayments')}</option>
            {Object.values(PaymentStatus).map(status => (
              <option key={status} value={status}>
                {tAll(`orders.paymentStatus.${status}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="orders-sort" className="text-xs">
            {t('filters.sort')}
          </Label>
          <select
            id="orders-sort"
            className={SELECT_CLASS}
            value={sort}
            onChange={event => setState({ filter, sort: event.target.value })}
          >
            {Object.values(OrderSorts).map(value => (
              <option key={value} value={value}>
                {t(`filters.sorts.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {canShip ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="orders-carrier" className="text-xs">
              {t('filters.carrier')}
            </Label>
            <select
              id="orders-carrier"
              className={SELECT_CLASS}
              value={filter.carrierConnectionId ?? ''}
              onChange={event =>
                change({
                  ...filter,
                  carrierConnectionId: event.target.value === '' ? undefined : event.target.value
                })
              }
            >
              <option value="">{t('filters.allCarriers')}</option>
              {connections.map(connection => (
                <option key={connection.id} value={connection.id}>
                  {connection.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="orders-guide" className="text-xs">
              {t('filters.guide')}
            </Label>
            <select
              id="orders-guide"
              className={SELECT_CLASS}
              value={filter.guide ?? ''}
              onChange={event =>
                change({
                  ...filter,
                  guide: event.target.value === '' ? undefined : event.target.value
                })
              }
            >
              <option value="">{t('filters.anyGuide')}</option>
              {Object.values(OrderGuideFilters).map(value => (
                <option key={value} value={value}>
                  {t(`filters.guides.${value}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="flex flex-wrap items-end gap-2">
          <legend className="mb-1 text-xs font-medium">{t('filters.created')}</legend>
          <div className="flex flex-col gap-1">
            <Label htmlFor="orders-created-from" className="sr-only">
              {t('filters.createdFrom')}
            </Label>
            <Input
              id="orders-created-from"
              type="date"
              value={filter.createdFrom ?? ''}
              max={filter.createdTo}
              onChange={event =>
                change({
                  ...filter,
                  createdFrom: event.target.value === '' ? undefined : event.target.value
                })
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="orders-created-to" className="sr-only">
              {t('filters.createdTo')}
            </Label>
            <Input
              id="orders-created-to"
              type="date"
              value={filter.createdTo ?? ''}
              min={filter.createdFrom}
              onChange={event =>
                change({
                  ...filter,
                  createdTo: event.target.value === '' ? undefined : event.target.value
                })
              }
            />
          </div>
        </fieldset>
        <fieldset className="flex flex-wrap items-end gap-2">
          <legend className="mb-1 text-xs font-medium">{t('filters.scheduled')}</legend>
          {Object.values(OrderScheduledDeliveryShortcuts).map(shortcut => {
            const isOn = filter.scheduledDeliveryOn === shortcut
            return (
              <Button
                key={shortcut}
                variant={isOn ? 'default' : 'outline'}
                size="sm"
                aria-pressed={isOn}
                onClick={() => change(withScheduledShortcut(filter, isOn ? undefined : shortcut))}
              >
                {t(`filters.shortcuts.${shortcut}`)}
              </Button>
            )
          })}
          <div className="flex flex-col gap-1">
            <Label htmlFor="orders-scheduled-from" className="sr-only">
              {t('filters.scheduledFrom')}
            </Label>
            <Input
              id="orders-scheduled-from"
              type="date"
              value={filter.scheduledDeliveryFrom ?? ''}
              max={filter.scheduledDeliveryTo}
              onChange={event =>
                change(
                  withScheduledDays(filter, {
                    from: event.target.value,
                    to: filter.scheduledDeliveryTo
                  })
                )
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="orders-scheduled-to" className="sr-only">
              {t('filters.scheduledTo')}
            </Label>
            <Input
              id="orders-scheduled-to"
              type="date"
              value={filter.scheduledDeliveryTo ?? ''}
              min={filter.scheduledDeliveryFrom}
              onChange={event =>
                change(
                  withScheduledDays(filter, {
                    from: filter.scheduledDeliveryFrom,
                    to: event.target.value
                  })
                )
              }
            />
          </div>
        </fieldset>
        {customerName === null ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => change({ ...filter, customerId: undefined })}
            aria-label={t('filters.removeCustomer', { name: customerName })}
          >
            {t('filters.customer', { name: customerName })}
            <X aria-hidden />
          </Button>
        )}
        {isFiltered ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setText('')
              setState({ filter: {}, sort })
            }}
          >
            {t('filters.clear', { count })}
          </Button>
        ) : null}
      </div>

      {orders.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : null}
      {orders.isError && rows.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button variant="outline" size="sm" onClick={() => void orders.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {orders.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{isFiltered ? t('noMatches') : t('empty')}</p>
      ) : null}

      {selection.size > 0 ? (
        <OrderBulkPanel
          storeId={storeId}
          selectedIds={selectedIds}
          rows={rows}
          rowsById={rowsById}
          guides={guides}
          connections={connections}
          can={can}
          onClear={() => setSelection(NO_SELECTION)}
        />
      ) : null}

      {rows.length === 0 ? null : (
        <div
          className={orders.isPlaceholderData ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}
          aria-busy={orders.isPlaceholderData}
        >
          <table className="w-full text-left">
            <thead>
              <tr className="border-b text-sm">
                <th className="py-2 pr-3 font-medium">
                  <input
                    type="checkbox"
                    className={CHECKBOX_CLASS}
                    checked={everyShownIsTicked}
                    onChange={() => setSelection(current => toggleAll(current, shownIds))}
                    aria-label={t('selectAll')}
                  />
                </th>
                <th className="py-2 pr-3 font-medium">{t('columns.number')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.customer')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.created')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.status')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.payment')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.scheduled')}</th>
                {canShip ? (
                  <>
                    <th className="py-2 pr-3 font-medium">{t('columns.carrier')}</th>
                    <th className="py-2 pr-3 font-medium">{t('columns.guide')}</th>
                    <th className="py-2 pr-3 font-medium">{t('columns.shipment')}</th>
                  </>
                ) : null}
                <th className="py-2 text-right font-medium">{t('columns.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(order => (
                <Row
                  key={order.id}
                  order={order}
                  isSelected={selection.has(order.id)}
                  onToggle={() => setSelection(current => toggleOrder(current, order.id))}
                  shipping={canShip ? { connections, guides: guides.get(order.id) ?? [] } : null}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {orders.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={orders.isFetchingNextPage}
          busy={orders.isFetchingNextPage}
          onClick={() => void orders.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
