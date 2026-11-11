'use client'

import { Printer } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import type { OrderDetailView } from '@platform/api-client'
import { OrderPrintDocuments, type OrderPrintDocument } from '@platform/core/domain'

import { readAddress } from '../../lib/orders/order-fields'
import { useDayText } from '../../lib/orders/use-day-text'
import { formatCents } from '../../lib/products/money'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { warehouseLabel } from './order-lines'

const PRINT_FALLBACK_MS = 120_000

// The documents the detail prints. The shipping label (the carrier's, Step 4.14) and the invoice (Step 4.13) are not here.
const DOCUMENTS = [OrderPrintDocuments.PACKING_SLIP, OrderPrintDocuments.ORDER_SUMMARY] as const
type PrintableDocument = Extract<OrderPrintDocument, (typeof DOCUMENTS)[number]>

// Printing: the browser prints a sheet that this draws at the end of the page (the print rules of globals.css hide the rest of
// the app), and "Save as PDF" of its print dialog makes the PDF. No library is shipped for it and no byte of the order leaves
// the browser. The sheet is only in the page while it is being printed, so nothing of it is drawn or kept the rest of the time.
// The internal note of customer care is never on a sheet: a sheet goes to the warehouse and travels with the parcel.
export function OrderPrintButtons({
  order,
  warehouseNames
}: {
  order: OrderDetailView
  warehouseNames: ReadonlyMap<string, string>
}): ReactElement {
  const t = useTranslations('orders.detail.print')
  const [printing, setPrinting] = useState<PrintableDocument | null>(null)

  useEffect(() => {
    if (printing === null) return
    const finish = (): void => setPrinting(null)
    window.addEventListener('afterprint', finish, { once: true })
    // A browser that never says it is done (a cancelled dialog, a blocked print) must not leave the sheet in the page
    const fallback = setTimeout(finish, PRINT_FALLBACK_MS)
    // One frame later, so the sheet is in the page when the dialog opens
    const frame = requestAnimationFrame(() => window.print())
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(fallback)
      window.removeEventListener('afterprint', finish)
    }
  }, [printing])

  return (
    <>
      <div role="group" aria-label={t('groupLabel')} className="flex flex-wrap gap-2">
        {DOCUMENTS.map(document => (
          <Button
            key={document}
            type="button"
            variant="outline"
            size="sm"
            disabled={printing !== null}
            onClick={() => setPrinting(document)}
          >
            <Printer aria-hidden />
            {t(`${document}.button`)}
          </Button>
        ))}
      </div>
      {printing !== null
        ? createPortal(
            <PrintSheet document={printing} order={order} warehouseNames={warehouseNames} />,
            // A child of the body, so the print rules can hide every other child of it
            window.document.body
          )
        : null}
    </>
  )
}

function PrintSheet({
  document,
  order,
  warehouseNames
}: {
  document: PrintableDocument
  order: OrderDetailView
  warehouseNames: ReadonlyMap<string, string>
}): ReactElement {
  const t = useTranslations('orders.detail.print')
  const tLines = useTranslations('orders.detail.lines')
  const tOrders = useTranslations('orders')
  const format = useFormatter()
  const dayText = useDayText()
  const { storeName } = useStore()
  const money = (cents: number): string => formatCents(format, cents)
  const address = readAddress(order.shippingAddress)
  const priced = document === OrderPrintDocuments.ORDER_SUMMARY
  const packingNote = order.packingNotes ?? null
  const customerNote = order.customerNotes ?? null
  return (
    <div data-print-sheet className="hidden bg-white p-8 text-black print:block">
      <header className="mb-4 flex items-start justify-between border-b-2 border-black pb-2">
        <div>
          <p className="text-sm">{storeName}</p>
          <h1 className="text-2xl font-bold">
            {t(`${document}.title`, { number: order.orderNumber })}
          </h1>
        </div>
        <p className="text-sm">
          {format.dateTime(new Date(order.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      </header>

      {packingNote !== null && packingNote !== '' ? (
        <section className="mb-4 border-2 border-black p-3" aria-label={t('packingNote')}>
          <p className="text-sm font-bold tracking-wide uppercase">{t('packingNote')}</p>
          <p className="text-lg font-semibold break-words whitespace-pre-wrap">{packingNote}</p>
        </section>
      ) : null}

      <section className="mb-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="font-bold">{t('customer')}</p>
          <p>{order.customer.name ?? tOrders('list.unnamedCustomer')}</p>
          {order.recipientPhones.length > 0 ? <p>{order.recipientPhones.join(' / ')}</p> : null}
        </div>
        <div>
          <p className="font-bold">{t('address')}</p>
          {address === null ? (
            <p>{t('noAddress')}</p>
          ) : (
            <address className="not-italic">
              <p>{address.line1}</p>
              {address.line2 === '' ? null : <p>{address.line2}</p>}
              <p>
                {[address.city, address.state, address.postalCode]
                  .filter(part => part !== '')
                  .join(', ')}
              </p>
              {address.country === '' ? null : <p>{address.country}</p>}
            </address>
          )}
          {order.scheduledDeliveryDate === null ? null : (
            <p className="mt-1">
              {t('scheduled')}: {dayText(order.scheduledDeliveryDate)}
            </p>
          )}
        </div>
      </section>

      {customerNote !== null && customerNote !== '' ? (
        <section className="mb-4 text-sm">
          <p className="font-bold">{t('customerNote')}</p>
          <p className="break-words whitespace-pre-wrap">{customerNote}</p>
        </section>
      ) : null}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-black text-left">
            {priced ? null : (
              <th scope="col" className="w-8 py-1">
                <span className="sr-only">{t('packed')}</span>
              </th>
            )}
            <th scope="col" className="py-1">
              {tLines('product')}
            </th>
            <th scope="col" className="py-1 text-right">
              {tLines('quantity')}
            </th>
            {priced ? (
              <>
                <th scope="col" className="py-1 text-right">
                  {tLines('unitPrice')}
                </th>
                <th scope="col" className="py-1 text-right">
                  {tLines('lineTotal')}
                </th>
              </>
            ) : (
              <th scope="col" className="py-1">
                {tLines('from')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {order.items.map(item => (
            <tr key={item.id} className="border-b border-black/40 align-top">
              {priced ? null : (
                <td className="py-1.5">
                  <span aria-hidden className="inline-block size-4 border border-black" />
                </td>
              )}
              <td className="py-1.5">
                {item.productName}
                {item.variantName === null ? null : ` · ${item.variantName}`}
              </td>
              <td className="py-1.5 text-right tabular-nums">{item.quantity}</td>
              {priced ? (
                <>
                  <td className="py-1.5 text-right tabular-nums">{money(item.unitPriceCents)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {money(item.quantity * item.unitPriceCents)}
                  </td>
                </>
              ) : (
                <td className="py-1.5">
                  {item.allocations
                    .map(
                      allocation =>
                        `${warehouseLabel(warehouseNames, allocation.warehouseId, tLines('otherWarehouse'))} (${allocation.quantity})`
                    )
                    .join(', ')}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {priced ? (
        <dl className="mt-3 ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
          <dt>{tLines('subtotal')}</dt>
          <dd className="text-right tabular-nums">{money(order.subtotalCents)}</dd>
          <dt>{tLines('shipping')}</dt>
          <dd className="text-right tabular-nums">{money(order.shippingCents)}</dd>
          <dt>{tLines('discount')}</dt>
          <dd className="text-right tabular-nums">
            {order.discountCents === 0 ? money(0) : money(-order.discountCents)}
          </dd>
          <dt className="border-t border-black pt-1 font-bold">{tLines('total')}</dt>
          <dd className="border-t border-black pt-1 text-right font-bold tabular-nums">
            {money(order.totalCents)}
          </dd>
        </dl>
      ) : null}
    </div>
  )
}
