'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import {
  addLine,
  type DraftLine,
  type FormField,
  parseQuantity,
  shownPriceCents
} from '../../lib/orders/order-form'
import type { StockOfLine } from '../../lib/orders/stock-of-line'
import { formatCents } from '../../lib/products/money'

import { OrderLineRow } from './order-line-row'
import { OrderProductPicker } from './order-product-picker'

// The items of an order form, shared by the create drawer and the edit drawer: the autocomplete of the catalog, the rows
// (quantity, price, warehouses) and the estimate. `locked` draws the rows without the means to change them.
export function OrderLinesSection({
  lines,
  onLines,
  canOverridePrice,
  stockOf,
  wrong,
  locked = false
}: {
  lines: readonly DraftLine[]
  onLines: (lines: DraftLine[]) => void
  canOverridePrice: boolean
  stockOf: (line: DraftLine) => StockOfLine
  wrong: { field: FormField; line?: string | undefined } | null
  locked?: boolean
}): ReactElement {
  const t = useTranslations('orders.create')
  const tLines = useTranslations('orders.create.lines')
  const format = useFormatter()
  const subtotal = lines.reduce(
    (sum, line) => sum + shownPriceCents(line) * (parseQuantity(line.quantity) ?? 0),
    0
  )
  return (
    <section aria-labelledby="order-lines-title" className="flex flex-col gap-3">
      <h3 id="order-lines-title" className="text-sm font-medium">
        {tLines('label')}
      </h3>
      {locked ? null : <OrderProductPicker onAdd={line => onLines(addLine(lines, line))} />}
      {lines.length === 0 ? (
        <p className="text-muted-foreground text-sm">{tLines('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {lines.map(line => (
            <OrderLineRow
              key={line.key}
              line={line}
              canOverridePrice={canOverridePrice && !locked}
              locked={locked}
              stock={stockOf(line)}
              problem={wrong?.line === line.key ? wrong.field : null}
              onChange={next => onLines(lines.map(row => (row.key === line.key ? next : row)))}
              onRemove={() => onLines(lines.filter(row => row.key !== line.key))}
            />
          ))}
        </ul>
      )}
      {wrong?.field === 'lines' ? (
        <p id="order-lines-error" role="alert" className="text-destructive text-sm">
          {t('errors.lines')}
        </p>
      ) : null}
      {lines.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          {tLines('subtotal', { amount: formatCents(format, subtotal) })} {tLines('estimateNote')}
        </p>
      ) : null}
    </section>
  )
}
