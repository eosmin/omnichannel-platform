'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { OrderDetailView } from '@platform/api-client'

import { formatCents } from '../../lib/products/money'

// What the lines of an order say about where they leave from: the warehouse by its name when the member may list them, and
// "another warehouse" when not (a deactivated one is not in the list either)
export function warehouseLabel(
  names: ReadonlyMap<string, string>,
  warehouseId: string,
  fallback: string
): string {
  return names.get(warehouseId) ?? fallback
}

// The lines of the order and their totals, in whole cents of the order currency written by the formatter (never a float
// anywhere in between: the line total is the product of two integers)
export function OrderLines({
  order,
  warehouseNames
}: {
  order: OrderDetailView
  warehouseNames: ReadonlyMap<string, string>
}): ReactElement {
  const t = useTranslations('orders.detail.lines')
  const format = useFormatter()
  const money = (cents: number): string => formatCents(format, cents)
  return (
    <section aria-labelledby="order-lines-heading" className="flex flex-col gap-3">
      <h2 id="order-lines-heading" className="text-base font-semibold">
        {t('heading')}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('caption', { number: order.orderNumber })}</caption>
          <thead>
            <tr className="text-muted-foreground border-b text-left">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {t('product')}
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                {t('quantity')}
              </th>
              <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                {t('unitPrice')}
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                {t('lineTotal')}
              </th>
            </tr>
          </thead>
          <tbody>
            {order.items.map(item => (
              <tr key={item.id} className="border-b align-top">
                <td className="py-2 pr-3">
                  <p className="font-medium">{item.productName}</p>
                  {item.variantName === null ? null : (
                    <p className="text-muted-foreground">{item.variantName}</p>
                  )}
                  {item.allocations.length > 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t('from')}{' '}
                      {item.allocations
                        .map(
                          allocation =>
                            `${warehouseLabel(warehouseNames, allocation.warehouseId, t('otherWarehouse'))} (${allocation.quantity})`
                        )
                        .join(', ')}
                    </p>
                  ) : null}
                  {item.freeShipping ? (
                    <p className="text-muted-foreground text-xs">{t('freeShipping')}</p>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{item.quantity}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {item.originalUnitPriceCents !== null &&
                  item.originalUnitPriceCents !== item.unitPriceCents ? (
                    <>
                      <span className="text-muted-foreground block text-xs line-through">
                        {money(item.originalUnitPriceCents)}
                      </span>
                      <span className="sr-only">{t('priceChanged')}</span>
                    </>
                  ) : null}
                  {money(item.unitPriceCents)}
                  {item.priceOverrideReason === null ? null : (
                    <span className="text-muted-foreground block max-w-48 text-xs break-words">
                      {item.priceOverrideReason}
                    </span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {money(item.quantity * item.unitPriceCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OrderTotals order={order} />
    </section>
  )
}

export function OrderTotals({ order }: { order: OrderDetailView }): ReactElement {
  const t = useTranslations('orders.detail.lines')
  const format = useFormatter()
  const money = (cents: number): string => formatCents(format, cents)
  return (
    <dl className="grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 self-end text-sm">
      <dt className="text-muted-foreground">{t('subtotal')}</dt>
      <dd className="text-right tabular-nums">{money(order.subtotalCents)}</dd>
      <dt className="text-muted-foreground">
        {t('shipping')}
        {order.freeShipping ? (
          <span className="block text-xs">{t('freeShippingOrder')}</span>
        ) : null}
      </dt>
      <dd className="text-right tabular-nums">{money(order.shippingCents)}</dd>
      <dt className="text-muted-foreground">
        {t('discount')}
        {order.discountReason === null ? null : (
          <span className="block text-xs break-words">{order.discountReason}</span>
        )}
      </dt>
      <dd className="text-right tabular-nums">
        {order.discountCents === 0 ? money(0) : money(-order.discountCents)}
      </dd>
      <dt className="border-t pt-1 font-semibold">{t('total')}</dt>
      <dd className="border-t pt-1 text-right font-semibold tabular-nums">
        {money(order.totalCents)}
      </dd>
    </dl>
  )
}
