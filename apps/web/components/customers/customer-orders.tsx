'use client'

import { ShoppingBag } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type CustomerOrderView } from '@platform/api-client'
import { OrderListFilters, OrderStatus } from '@platform/core/domain'

import { ORDERS_ALL, useCustomerOrders } from '../../lib/customers/use-customer-data'
import { orderStatusKey } from '../../lib/orders/order-status'
import { formatCents } from '../../lib/products/money'
import { OrderCopyButton } from '../orders/order-copy-button'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

const FILTERS: readonly (typeof ORDERS_ALL | OrderStatus)[] = [
  ORDERS_ALL,
  ...Object.values(OrderStatus)
]

function OrderRow({
  order,
  onNavigate
}: {
  order: CustomerOrderView
  onNavigate: () => void
}): ReactElement {
  const t = useTranslations('customers.orders')
  const tOrders = useTranslations('orders')
  const format = useFormatter()
  const { storeId } = useStore()
  const statusKey = orderStatusKey(order.status)
  const made = new Date(order.createdAt)
  return (
    <li className="flex flex-col gap-1 rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={AppPaths.store.order(storeId, order.id)}
          onClick={onNavigate}
          className="font-medium underline-offset-4 hover:underline"
        >
          {tOrders('list.number', { number: order.orderNumber })}
        </Link>
        <span className="font-medium">{formatCents(format, order.totalCents)}</span>
      </div>
      <div className="flex justify-end">
        <OrderCopyButton orderId={order.id} orderNumber={order.orderNumber} onOpened={onNavigate} />
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>
          {statusKey === null ? tOrders('list.unknownStatus') : tOrders(`status.${statusKey}`)}
        </span>
        <span>{t('lines', { count: order.itemCount })}</span>
        <span>
          {Number.isNaN(made.getTime()) ? '' : format.dateTime(made, { dateStyle: 'medium' })}
        </span>
      </div>
    </li>
  )
}

// The orders of the customer (TDD_09 §6): a tab of the profile with a filter by state and the newest first. The
// figures sit with the others of the profile (see `CustomerFigures`).
export function CustomerOrders({
  customerId,
  onNavigate
}: {
  customerId: string
  onNavigate: () => void
}): ReactElement {
  const t = useTranslations('customers.orders')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const [status, setStatus] = useState<string>(ORDERS_ALL)
  const orders = useCustomerOrders(storeId, customerId, status, true)
  const rows = orders.data?.pages.flatMap(page => page.data) ?? []

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={status} onValueChange={setStatus}>
        <TabsList aria-label={t('filterLabel')} className="h-auto flex-wrap">
          {FILTERS.map(item => (
            <TabsTrigger key={item} value={item}>
              {item === ORDERS_ALL ? t('all') : tAll(`orders.status.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {orders.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : null}
      {orders.isError && rows.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void orders.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {orders.isError && rows.length > 0 ? (
        <p role="alert" className="text-sm">
          {t('failed')}
        </p>
      ) : null}
      {orders.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {status === ORDERS_ALL ? t('empty') : t('noMatches')}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {rows.map(order => (
          <OrderRow key={order.id} order={order} onNavigate={onNavigate} />
        ))}
      </ul>

      {orders.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={orders.isFetchingNextPage}
          onClick={() => void orders.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}

      <Link
        href={`${AppPaths.store.orders(storeId)}?${OrderListFilters.CUSTOMER_ID}=${customerId}`}
        onClick={onNavigate}
        className="inline-flex items-center gap-2 self-start text-sm underline-offset-4 hover:underline"
      >
        <ShoppingBag aria-hidden className="size-4" />
        {t('viewAll')}
      </Link>
    </div>
  )
}
