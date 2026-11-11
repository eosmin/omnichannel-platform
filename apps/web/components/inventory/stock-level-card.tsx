'use client'

import { ArrowLeftRight, BellRing, Plus, TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef } from 'react'

import type { StockLevelView } from '@platform/api-client'

import { formatCents } from '../../lib/products/money'
import { StockKardex } from '../products/stock-kardex'
import { Button } from '../ui/button'

// One item in one warehouse of the store, as a card: on a phone a table of seven columns would scroll sideways, and a
// card keeps the three numbers and the buttons in reach of a thumb. The buttons come first, under the name.
export function StockLevelCard({
  level,
  isShown,
  isLow,
  onToggleMovements,
  onAdjust,
  onThreshold
}: {
  level: StockLevelView
  // Whether its movements are open under it
  isShown: boolean
  // Whether to flag it as low: the screen says so when it lists only the products at their threshold
  isLow: boolean
  onToggleMovements: () => void
  // Absent when the person may not adjust / edit the threshold: the button is not drawn
  onAdjust: (() => void) | null
  onThreshold: (() => void) | null
}): ReactElement {
  const t = useTranslations('stock.card')
  const tStock = useTranslations('products.stock')
  const format = useFormatter()
  const item = level.variantName ?? tStock('productRow')
  const movementsHeading = useRef<HTMLHeadingElement | null>(null)
  // Opening the movements moves the focus to their heading, so the keyboard and a screen reader follow
  useEffect(() => {
    if (isShown) movementsHeading.current?.focus()
  }, [isShown])
  const headingId = `stock-level-${level.id}`

  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="text-base font-medium break-words">
          {level.productName}
        </h2>
        {level.variantName === null && level.productSku === null ? null : (
          <p className="text-muted-foreground text-sm break-words">
            {[level.variantName, level.variantSku ?? level.productSku]
              .filter((part): part is string => part !== null && part !== '')
              .join(' · ')}
          </p>
        )}
        <p className="text-muted-foreground text-sm">
          <span className="font-medium">{level.warehouseCode}</span> · {level.warehouseName}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:min-h-10"
          aria-pressed={isShown}
          aria-label={tStock('movementsOf', { item, warehouse: level.warehouseCode })}
          onClick={onToggleMovements}
        >
          <ArrowLeftRight aria-hidden />
          {tStock('movements')}
        </Button>
        {onAdjust === null ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:min-h-10"
            aria-label={tStock('adjustFor', { item, warehouse: level.warehouseCode })}
            onClick={onAdjust}
          >
            <Plus aria-hidden />
            {tStock('adjust')}
          </Button>
        )}
        {onThreshold === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-coarse:min-h-10"
            aria-label={t('thresholdFor', { product: level.productName })}
            onClick={onThreshold}
          >
            <BellRing aria-hidden />
            {t('threshold')}
          </Button>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <Figure label={tStock('columns.onHand')} value={level.onHand} />
        <Figure label={tStock('columns.reserved')} value={level.reserved} />
        <Figure label={tStock('columns.available')} value={level.available} />
      </dl>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-muted-foreground">
          {level.lowStockThreshold === null
            ? t('noThreshold')
            : t('thresholdAt', { count: level.lowStockThreshold })}
        </span>
        {isLow ? (
          <span className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
            <TriangleAlert aria-hidden className="size-3.5" />
            {tStock('low')}
          </span>
        ) : null}
        {level.available < 0 ? (
          <span className="text-destructive font-medium">{tStock('oversold')}</span>
        ) : null}
      </div>

      {level.valueCents === undefined ? null : (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <Figure label={tStock('columns.value')} text={formatCents(format, level.valueCents)} />
          <Figure
            label={tStock('columns.averageCost')}
            text={
              level.averageCostCents === undefined || level.averageCostCents === null
                ? ''
                : formatCents(format, level.averageCostCents)
            }
          />
        </dl>
      )}

      {isShown ? (
        <div
          role="region"
          aria-labelledby={`${headingId}-movements`}
          className="flex flex-col gap-2"
        >
          <h3
            id={`${headingId}-movements`}
            ref={movementsHeading}
            tabIndex={-1}
            className="font-medium outline-none"
          >
            {tStock('movementsOf', { item, warehouse: level.warehouseCode })}
          </h3>
          <StockKardex
            item={{
              productId: level.productId,
              variantId: level.variantId,
              warehouseId: level.warehouseId
            }}
          />
        </div>
      ) : null}
    </li>
  )
}

function Figure({
  label,
  value,
  text
}: {
  label: string
  value?: number
  text?: string
}): ReactElement {
  return (
    <div className="bg-muted/40 flex flex-col rounded-md p-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{text ?? value}</dd>
    </div>
  )
}
