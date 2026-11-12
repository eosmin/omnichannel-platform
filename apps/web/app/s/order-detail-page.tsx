'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ApiError, AppPaths, type OrderDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import {
  OrderCancellationReasons,
  OrderConfirmationChannel,
  PriceApprovalStatus
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

import { useCustomerDrawer } from '../../components/customers/customer-drawer-context'
import { OrderDelivery } from '../../components/orders/order-delivery'
import { OrderEditButton } from '../../components/orders/order-edit-button'
import { OrderFileLink } from '../../components/orders/order-file-link'
import { OrderFlowButtons } from '../../components/orders/order-flows'
import { OrderLines } from '../../components/orders/order-lines'
import { OrderNotes } from '../../components/orders/order-notes'
import { OrderPayment } from '../../components/orders/order-payment'
import { OrderPrintButtons } from '../../components/orders/order-print'
import { OrderReturns } from '../../components/orders/order-returns'
import { OrderShipping } from '../../components/orders/order-shipping'
import { useStore } from '../../components/providers/store-context'
import { Button } from '../../components/ui/button'
import { useWarehousesOfStore } from '../../lib/inventory/use-inventory'
import { asOrderStatus, asPriceApprovalStatus } from '../../lib/orders/order-detail-rules'
import { outboundStatusesOf } from '../../lib/orders/order-shipping-rules'
import { useOrder, useOrderWrites } from '../../lib/orders/use-order'
import { useOrderShipments, useShipmentWrites } from '../../lib/orders/use-order-shipping'

function BackLink(): ReactElement {
  const t = useTranslations('orders.detail')
  const { storeId } = useStore()
  return (
    <Link
      href={AppPaths.store.orders(storeId)}
      className="inline-flex items-center gap-1 self-start text-sm underline-offset-2 hover:underline"
    >
      <ArrowLeft aria-hidden className="size-4" />
      {t('back')}
    </Link>
  )
}

// A cancellation reason is one of the factory keys (it reads in the language of the reader) or the text somebody wrote
function useReasonText(): (reason: string) => string {
  const t = useTranslations()
  return reason =>
    (Object.values(OrderCancellationReasons) as string[]).includes(reason)
      ? t(reason as 'orders.cancellationReason.other')
      : reason
}

function OrderEvents({ order }: { order: OrderDetailView }): ReactElement {
  const t = useTranslations('orders.detail.events')
  const format = useFormatter()
  const reasonText = useReasonText()
  const moment = (iso: string): string =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const rows: { key: string; label: string; at: string; extra?: ReactElement | string }[] = [
    { key: 'created', label: t('created'), at: order.createdAt }
  ]
  // A way of a newer server is not one of ours: the moment is drawn without it
  const via = Object.values(OrderConfirmationChannel).find(known => known === order.confirmedVia)
  if (order.confirmedAt !== null) {
    rows.push({
      key: 'confirmed',
      label: t('confirmed'),
      at: order.confirmedAt,
      extra: via === undefined ? undefined : t(`via.${via}`)
    })
  }
  if (order.shippedAt !== null)
    rows.push({ key: 'shipped', label: t('shipped'), at: order.shippedAt })
  if (order.deliveredAt !== null) {
    rows.push({
      key: 'delivered',
      label: t('delivered'),
      at: order.deliveredAt,
      extra:
        order.proofOfDeliveryMediaId === null ? undefined : (
          <OrderFileLink mediaId={order.proofOfDeliveryMediaId} />
        )
    })
  }
  if (order.cancelledAt !== null) {
    rows.push({
      key: 'cancelled',
      label: t('cancelled'),
      at: order.cancelledAt,
      extra: order.cancellationReason === null ? undefined : reasonText(order.cancellationReason)
    })
  }
  return (
    <section aria-labelledby="order-events-heading" className="flex flex-col gap-2">
      <h2 id="order-events-heading" className="text-base font-semibold">
        {t('heading')}
      </h2>
      <ol className="flex flex-col gap-1.5 text-sm">
        {rows.map(row => (
          <li key={row.key}>
            <span className="font-medium">{row.label}</span>{' '}
            <time dateTime={row.at} className="text-muted-foreground">
              {moment(row.at)}
            </time>
            {row.extra === undefined ? null : <p className="break-words">{row.extra}</p>}
          </li>
        ))}
      </ol>
    </section>
  )
}

function CustomerBlock({ order }: { order: OrderDetailView }): ReactElement {
  const t = useTranslations('orders.detail.customer')
  const tList = useTranslations('orders.list')
  const { openCustomer } = useCustomerDrawer()
  const { can } = useStore()
  return (
    <section aria-labelledby="order-customer-heading" className="flex flex-col gap-1.5">
      <h2 id="order-customer-heading" className="text-base font-semibold">
        {t('heading')}
      </h2>
      <div className="text-sm">
        {can(ClientPermissions.CUSTOMERS_VIEW) ? (
          <Button
            type="button"
            variant="ghost"
            className="h-auto px-1 py-0.5 font-medium"
            onClick={() => openCustomer(order.customer.id)}
          >
            {order.customer.name ?? tList('unnamedCustomer')}
          </Button>
        ) : (
          <p className="font-medium">{order.customer.name ?? tList('unnamedCustomer')}</p>
        )}
        {order.customer.email === null ? null : <p>{order.customer.email}</p>}
        {order.customer.phone === null ? null : <p>{order.customer.phone}</p>}
      </div>
    </section>
  )
}

// The page an order number of the list opens: the order with what the member may read of it, the flows of its life, its
// payment, its delivery, its three notes and the documents it prints. The api decides every change; what this offers is what
// the order accepts in its status and what the member holds (order-detail-rules.ts).
export function OrderDetailPage(): ReactElement {
  const t = useTranslations('orders.detail')
  const tOrders = useTranslations('orders')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const params = useParams<{ orderId: string }>()
  const orderId = params.orderId
  const mayView = can(ClientPermissions.ORDERS_VIEW)
  const order = useOrder(storeId, orderId, mayView)
  const writes = useOrderWrites(storeId, orderId)
  const shipments = useOrderShipments(
    storeId,
    orderId,
    mayView && can(ClientPermissions.SHIPPING_VIEW)
  )
  const shipmentWrites = useShipmentWrites(storeId, orderId)
  const warehouses = useWarehousesOfStore(storeId, can(ClientPermissions.INVENTORY_VIEW))
  const warehouseNames = new Map((warehouses.data ?? []).map(w => [w.id, w.name]))

  if (!mayView) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm">
          {t('noAccess')}
        </p>
      </div>
    )
  }
  if (order.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      </div>
    )
  }
  // A failed refresh of an order already on the screen keeps the screen (and the dialog or form open on it)
  if (order.data === undefined) {
    const missing =
      order.error instanceof ApiError && order.error.status === HttpStatusCodes.NOT_FOUND
    return (
      <div className="flex flex-col items-start gap-3">
        <BackLink />
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm">
          {missing ? t('notFound') : t('failed')}
        </p>
        {missing ? null : (
          <Button variant="outline" size="sm" onClick={() => void order.refetch()}>
            {t('tryAgain')}
          </Button>
        )}
      </div>
    )
  }
  const data = order.data
  const status = asOrderStatus(data.status)
  return (
    <div className="flex flex-col gap-5">
      <BackLink />
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{t('heading', { number: data.orderNumber })}</h1>
          <span className="rounded border px-1.5 py-0.5 text-xs font-medium">
            {status === null ? tOrders('list.unknownStatus') : tOrders(`status.${status}`)}
          </span>
          {asPriceApprovalStatus(data.priceApprovalStatus) === PriceApprovalStatus.PENDING ? (
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              {tOrders('list.awaitingPriceApproval')}
            </span>
          ) : null}
          <span className="text-muted-foreground text-sm">
            {t('made', {
              date: format.dateTime(new Date(data.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short'
              })
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OrderEditButton order={data} />
          <OrderFlowButtons order={data} writes={writes} />
        </div>
        <OrderPrintButtons order={data} warehouseNames={warehouseNames} />
      </header>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-6">
          <OrderNotes order={data} writes={writes} />
          <OrderLines order={data} warehouseNames={warehouseNames} />
          <OrderShipping
            order={data}
            shipments={shipments.data ?? []}
            isPending={shipments.isPending}
            isError={shipments.isError}
            writes={shipmentWrites}
            carrierCanCancel={() => null}
          />
          <OrderReturns
            order={data}
            outboundStatuses={outboundStatusesOf(shipments.data ?? [])}
            warehouses={warehouses.data ?? []}
          />
        </div>
        <div className="flex flex-col gap-6">
          <CustomerBlock order={data} />
          <OrderPayment order={data} writes={writes} />
          <OrderDelivery order={data} writes={writes} />
          <OrderEvents order={data} />
        </div>
      </div>
    </div>
  )
}
