'use client'

import { ArrowLeftRight, Plus, TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import type { ProductDetailView, StockLevelView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { useProductInventory } from '../../lib/inventory/use-inventory'
import { formatCents } from '../../lib/products/money'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { StockAdjustDialog } from './stock-adjust-dialog'
import { StockKardex } from './stock-kardex'

// The item a row is about, for the kardex and for the dialog to start from
interface Item {
  levelId: string
  variantId: string | null
  warehouseId: string
  label: string
  warehouseLabel: string
}

// The "Stock" tab: what is on hand, reserved and available in each warehouse of the store, by variant; the warning
// when the product is at its alert threshold; the adjustment; and the kardex of the row chosen. Cost columns (the value
// of the units and their average cost) exist only when the api sent them, which it does for who holds
// products:view_cost.
export function StockTab({ product }: { product: ProductDetailView }): ReactElement {
  const t = useTranslations('products.stock')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const mayView = can(ClientPermissions.INVENTORY_VIEW)
  const mayAdjust = can(ClientPermissions.INVENTORY_ADJUST)
  const inventory = useProductInventory(storeId, product.id, mayView)
  const [adjusting, setAdjusting] = useState<{ open: boolean; from: Item | null }>({
    open: false,
    from: null
  })
  const [shown, setShown] = useState<Item | null>(null)
  // Opening the movements of a row moves the focus to their heading, so the keyboard and a screen reader follow
  const movementsHeading = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => {
    if (shown !== null) movementsHeading.current?.focus()
  }, [shown])

  if (!mayView) return <p className="text-sm">{t('noAccess')}</p>
  if (!product.trackInventory) {
    return <p className="text-muted-foreground text-sm">{t('notTracked')}</p>
  }
  if (inventory.isError && inventory.data === undefined) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{t('failed')}</p>
        <Button variant="outline" size="sm" onClick={() => void inventory.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </div>
    )
  }
  if (inventory.data === undefined) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {tAll('common.loading')}
      </p>
    )
  }

  const { levels, onHand, reserved, available, lowStockThreshold } = inventory.data
  const hasCost = levels.some(level => level.valueCents !== undefined)
  const isLow = lowStockThreshold !== null && available <= lowStockThreshold
  const itemOf = (level: StockLevelView): Item => ({
    levelId: level.id,
    variantId: level.variantId,
    warehouseId: level.warehouseId,
    label: level.variantName ?? t('productRow'),
    warehouseLabel: level.warehouseCode
  })

  return (
    <section aria-labelledby="product-stock-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h3 id="product-stock-heading" className="font-medium">
            {t('heading')}
          </h3>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {mayAdjust ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setAdjusting({ open: true, from: null })}
          >
            <Plus aria-hidden />
            {t('adjust')}
          </Button>
        ) : null}
      </div>

      <dl className="grid grid-cols-3 gap-3 text-sm">
        <Total label={t('totals.onHand')} value={onHand} />
        <Total label={t('totals.reserved')} value={reserved} />
        <Total label={t('totals.available')} value={available} />
      </dl>
      {isLow ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {t.rich('lowBanner', {
              b: chunks => <span className="font-medium">{chunks}</span>,
              available,
              threshold: lowStockThreshold
            })}
          </span>
        </p>
      ) : null}
      {inventory.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('refreshFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void inventory.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}

      {levels.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">{t('columns.warehouse')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.item')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('columns.onHand')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('columns.reserved')}</th>
                <th className="py-2 pr-3 text-right font-medium">{t('columns.available')}</th>
                {hasCost ? (
                  <>
                    <th className="py-2 pr-3 text-right font-medium">{t('columns.value')}</th>
                    <th className="py-2 pr-3 text-right font-medium">{t('columns.averageCost')}</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {levels.map(level => (
                <tr key={level.id} className="border-b align-top">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{level.warehouseCode}</span>
                    <span className="text-muted-foreground block">{level.warehouseName}</span>
                    {/* The buttons sit under the warehouse, the first column: on a phone the table scrolls
                        sideways and a last column of actions would be out of sight */}
                    <div className="mt-1 flex flex-col items-start gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-pressed={shown?.levelId === level.id}
                        aria-label={t('movementsOf', {
                          item: level.variantName ?? t('productRow'),
                          warehouse: level.warehouseCode
                        })}
                        onClick={() => setShown(shown?.levelId === level.id ? null : itemOf(level))}
                      >
                        <ArrowLeftRight aria-hidden />
                        {t('movements')}
                      </Button>
                      {mayAdjust ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={t('adjustFor', {
                            item: level.variantName ?? t('productRow'),
                            warehouse: level.warehouseCode
                          })}
                          onClick={() => setAdjusting({ open: true, from: itemOf(level) })}
                        >
                          {t('adjust')}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                  <td className="py-2 pr-3">{level.variantName ?? t('productRow')}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{level.onHand}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{level.reserved}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {level.available}
                    {level.available < 0 ? (
                      <span className="text-destructive block text-xs">{t('oversold')}</span>
                    ) : null}
                  </td>
                  {hasCost ? (
                    <>
                      <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                        {level.valueCents === undefined
                          ? ''
                          : formatCents(format, level.valueCents)}
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
                        {level.averageCostCents === undefined || level.averageCostCents === null
                          ? ''
                          : formatCents(format, level.averageCostCents)}
                      </td>
                    </>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shown === null ? null : (
        <div
          className="flex flex-col gap-2"
          role="region"
          aria-labelledby="product-stock-movements"
        >
          <h4
            id="product-stock-movements"
            ref={movementsHeading}
            tabIndex={-1}
            className="font-medium outline-none"
          >
            {t('movementsOf', { item: shown.label, warehouse: shown.warehouseLabel })}
          </h4>
          <StockKardex
            key={shown.levelId}
            item={{
              productId: product.id,
              variantId: shown.variantId,
              warehouseId: shown.warehouseId
            }}
          />
        </div>
      )}

      {mayAdjust ? (
        <StockAdjustDialog
          product={product}
          open={adjusting.open}
          onOpenChange={open => setAdjusting(current => ({ ...current, open }))}
          initial={
            adjusting.from === null
              ? undefined
              : { warehouseId: adjusting.from.warehouseId, variantId: adjusting.from.variantId }
          }
        />
      ) : null}
    </section>
  )
}

function Total({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="flex flex-col rounded-md border p-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
