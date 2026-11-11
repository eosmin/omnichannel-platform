'use client'

import { Trash2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import {
  allocationProblem,
  type DraftLine,
  type FormField,
  parseQuantity,
  plannedAllocations,
  type StockRules
} from '../../lib/orders/order-form'
import { centsToInput, formatCents, parseCents } from '../../lib/products/money'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export interface StockOfLine {
  // Null while it loads or when the member may not read the inventory
  rules: StockRules | null
  isLoading: boolean
  isFailed: boolean
  names: ReadonlyMap<string, string>
  // The member may read the stock and the settings, so the choice can be checked here as the server checks it
  canChoose: boolean
}

// One item of the order: its quantity, its price (the catalog's, or another one for who may override it), and where its
// units come from. The server decides every one of these again.
export function OrderLineRow({
  line,
  canOverridePrice,
  stock,
  problem,
  onChange,
  onRemove
}: {
  line: DraftLine
  canOverridePrice: boolean
  stock: StockOfLine
  problem: FormField | null
  onChange: (next: DraftLine) => void
  onRemove: () => void
}): ReactElement {
  const t = useTranslations('orders.create')
  const tLines = useTranslations('orders.create.lines')
  const tStock = useTranslations('orders.create.stock')
  const format = useFormatter()
  const name =
    line.variantName === null ? line.productName : `${line.productName} · ${line.variantName}`
  const id = `order-line-${line.key.replace(/[^a-zA-Z0-9]/g, '-')}`
  const quantity = parseQuantity(line.quantity)
  const showReason =
    canOverridePrice &&
    line.priceText !== null &&
    parseCents(line.priceText) !== line.catalogPriceCents
  const planned =
    stock.rules !== null && quantity !== null ? plannedAllocations(quantity, stock.rules) : null
  const wrong = (field: FormField) => (problem === field ? { 'aria-invalid': true } : {})
  const allocationError =
    stock.rules !== null && line.allocations !== null ? allocationProblem(line, stock.rules) : null

  const startChoosing = (): void => {
    const start: Record<string, string> = {}
    for (const row of planned ?? []) start[row.warehouseId] = String(row.quantity)
    onChange({ ...line, allocations: start })
  }

  return (
    <li className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-medium break-words">{name}</span>
          {line.sku !== null ? (
            <span className="text-muted-foreground text-xs">{line.sku}</span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={tLines('remove', { name })}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-quantity`}>{tLines('quantity', { name })}</Label>
          <Input
            id={`${id}-quantity`}
            inputMode="numeric"
            autoComplete="off"
            value={line.quantity}
            // The units changed: a choice of warehouses made for the old quantity no longer adds up
            onChange={event =>
              onChange({ ...line, quantity: event.target.value, allocations: null })
            }
            {...wrong('quantity')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-price`}>{tLines('unitPrice', { name })}</Label>
          {canOverridePrice ? (
            <Input
              id={`${id}-price`}
              inputMode="decimal"
              autoComplete="off"
              value={line.priceText ?? centsToInput(line.catalogPriceCents)}
              onChange={event => onChange({ ...line, priceText: event.target.value })}
              {...wrong('price')}
            />
          ) : (
            <>
              <Input
                id={`${id}-price`}
                readOnly
                aria-describedby={`${id}-price-help`}
                value={formatCents(format, line.catalogPriceCents)}
              />
              <p id={`${id}-price-help`} className="text-muted-foreground text-xs">
                {tLines('priceLocked')}
              </p>
            </>
          )}
          {canOverridePrice ? (
            <p className="text-muted-foreground text-xs">
              {tLines('catalogPrice', { price: formatCents(format, line.catalogPriceCents) })}
            </p>
          ) : null}
        </div>
      </div>
      {showReason ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-reason`}>{tLines('priceReason', { name })}</Label>
          <Input
            id={`${id}-reason`}
            autoComplete="off"
            value={line.priceReason}
            onChange={event => onChange({ ...line, priceReason: event.target.value })}
            {...wrong('priceReason')}
          />
        </div>
      ) : null}

      {stock.isLoading ? (
        <p role="status" className="text-muted-foreground text-xs">
          {tStock('loading')}
        </p>
      ) : stock.isFailed ? (
        <p role="status" className="text-muted-foreground text-xs">
          {tStock('failed')}
        </p>
      ) : stock.rules !== null ? (
        <div
          className="flex flex-col gap-2 text-sm"
          role="group"
          aria-label={tStock('title', { name })}
        >
          <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {stock.rules.warehouses.map(warehouse => (
              <li key={warehouse.warehouseId}>
                {tStock('available', {
                  count: warehouse.available,
                  warehouse: stock.names.get(warehouse.warehouseId) ?? warehouse.warehouseId
                })}
              </li>
            ))}
          </ul>
          {line.allocations === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>{tStock('automatic')}</span>
              {planned !== null ? (
                <span className="text-muted-foreground text-xs">
                  {tStock('planned', {
                    plan: planned
                      .map(
                        row =>
                          `${stock.names.get(row.warehouseId) ?? row.warehouseId} × ${row.quantity}`
                      )
                      .join(', ')
                  })}
                </span>
              ) : quantity !== null ? (
                <span role="alert" className="text-destructive text-xs">
                  {tStock('short')}
                </span>
              ) : null}
              {stock.canChoose && planned !== null ? (
                <Button type="button" variant="outline" size="sm" onClick={startChoosing}>
                  {tStock('choose')}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span>{tStock('manual')}</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {stock.rules.warehouses.map(warehouse => {
                  const warehouseName =
                    stock.names.get(warehouse.warehouseId) ?? warehouse.warehouseId
                  return (
                    <div key={warehouse.warehouseId} className="flex flex-col gap-1">
                      <Label htmlFor={`${id}-wh-${warehouse.warehouseId}`}>
                        {tStock('units', { warehouse: warehouseName })}
                      </Label>
                      <Input
                        id={`${id}-wh-${warehouse.warehouseId}`}
                        inputMode="numeric"
                        autoComplete="off"
                        value={line.allocations?.[warehouse.warehouseId] ?? ''}
                        onChange={event =>
                          onChange({
                            ...line,
                            allocations: {
                              ...line.allocations,
                              [warehouse.warehouseId]: event.target.value
                            }
                          })
                        }
                        {...(allocationError !== null || problem === 'allocations'
                          ? { 'aria-invalid': true }
                          : {})}
                      />
                      <span className="text-muted-foreground text-xs">
                        {tStock('availableShort', { count: warehouse.available })}
                      </span>
                    </div>
                  )
                })}
              </div>
              {allocationError !== null ? (
                <p role="alert" className="text-destructive text-xs">
                  {tStock(`problem.${allocationError}`)}
                </p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => onChange({ ...line, allocations: null })}
              >
                {tStock('useAutomatic')}
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {problem === 'allocations' ? (
        <p role="alert" className="text-destructive text-sm">
          {t('errors.allocations')}
        </p>
      ) : null}
    </li>
  )
}
