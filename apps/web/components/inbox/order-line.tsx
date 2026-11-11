'use client'

import { ShoppingBag } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths, type MessageView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { OrderSummaryEvents } from '@platform/core/domain'

import { orderStatusKey } from '../../lib/orders/order-status'
import { formatCents } from '../../lib/products/money'
import { useStore } from '../providers/store-context'

// What happened to an order that came from this conversation (TDD_09 §5): a line between the messages, written in the
// language of who reads it, with the number, the state and the total, and a link to the order for who may open it. The
// line holds no note, address or phone of the order. It is never sent to the customer.
export function OrderLine({
  line
}: {
  line: NonNullable<MessageView['orderSummary']>
}): ReactElement {
  const t = useTranslations('inbox.thread.orderLine')
  const tOrders = useTranslations('orders')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const stateText = (state: string): string => {
    const key = orderStatusKey(state)
    return key === null ? tOrders('list.unknownStatus') : tOrders(`status.${key}`)
  }
  const isCreation = line.event === OrderSummaryEvents.CREATED
  return (
    <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-2 gap-y-1 py-1 text-center text-xs">
      <ShoppingBag aria-hidden className="size-4 shrink-0" />
      <span>
        {isCreation
          ? t('created', {
              number: line.orderNumber,
              status: stateText(line.status),
              total: formatCents(format, line.totalCents)
            })
          : line.previousStatus === null
            ? t('statusSet', { number: line.orderNumber, status: stateText(line.status) })
            : t('statusChanged', {
                number: line.orderNumber,
                previous: stateText(line.previousStatus),
                status: stateText(line.status)
              })}
      </span>
      {can(ClientPermissions.ORDERS_VIEW) ? (
        <Link
          href={AppPaths.store.order(storeId, line.orderId)}
          className="text-foreground underline-offset-4 hover:underline"
        >
          {t('open', { number: line.orderNumber })}
        </Link>
      ) : null}
    </div>
  )
}
