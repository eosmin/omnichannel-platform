'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useMemo } from 'react'

import type { StockLevelView } from '@platform/api-client'

import type { StockProduct } from '../../lib/inventory/stock-form'
import { useProductInventory } from '../../lib/inventory/use-inventory'
import { StockAdjustDialog } from '../products/stock-adjust-dialog'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The adjustment dialog of the catalog, started from a row of the stock screen. The dialog needs the variants the
// product can be adjusted by: they are read from the levels of the product (`inventory:view`, which this screen
// already needs), so a person who may adjust stock does not also need the right to read the catalog.
export function StockAdjustForLevel({
  level,
  onClose
}: {
  level: StockLevelView | null
  onClose: () => void
}): ReactElement | null {
  const t = useTranslations()
  const { storeId } = useStore()
  const inventory = useProductInventory(storeId, level?.productId ?? '', level !== null)
  const product = useMemo<StockProduct | null>(() => {
    if (level === null || inventory.data === undefined) return null
    const seen = new Map<string, string>()
    for (const row of inventory.data.levels) {
      if (row.variantId !== null) seen.set(row.variantId, row.variantName ?? '')
    }
    return {
      id: level.productId,
      variants: [...seen].map(([id, name]) => ({ id, name, active: true }))
    }
  }, [level, inventory.data])

  if (level !== null && inventory.isError && inventory.data === undefined) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{t('products.stock.failed')}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void inventory.refetch()}>
            {t('common.tryAgain')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    )
  }
  if (level === null || product === null) return null
  return (
    <StockAdjustDialog
      product={product}
      open
      onOpenChange={open => (open ? undefined : onClose())}
      initial={{ warehouseId: level.warehouseId, variantId: level.variantId }}
    />
  )
}
