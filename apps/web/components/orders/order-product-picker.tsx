'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { fetchProduct, type ProductDetailView, QueryKeys } from '@platform/api-client'

import { apiClient } from '../../lib/api'
import type { DraftLine } from '../../lib/orders/order-form'
import { ProductFilters, useProductSearch } from '../../lib/products/use-products'
import { useDebouncedValue } from '../../lib/use-debounced-value'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

const SEARCH_DELAY_MS = 250

type NewLine = Omit<DraftLine, 'key'>

function lineOf(
  product: Pick<ProductDetailView, 'id' | 'name' | 'sku' | 'priceCents'>,
  variant: { id: string; name: string; sku: string | null; effectivePriceCents: number } | null
): NewLine {
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    productName: product.name,
    variantName: variant?.name ?? null,
    sku: variant?.sku ?? product.sku,
    catalogPriceCents: variant?.effectivePriceCents ?? product.priceCents,
    quantity: '1',
    priceText: null,
    priceReason: '',
    allocations: null
  }
}

// The autocomplete of the catalog (Step 4.1). A product that is sold by variant asks which one before it is added: the
// search names the variant when it matched one, and the product is read otherwise.
export function OrderProductPicker({ onAdd }: { onAdd: (line: NewLine) => void }): ReactElement {
  const t = useTranslations('orders.create.lines')
  const { storeId } = useStore()
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS)
  const search = useProductSearch(storeId, q, ProductFilters.ACTIVE, true)
  const [choosing, setChoosing] = useState<ProductDetailView | null>(null)
  const [failed, setFailed] = useState(false)
  const results = search.data ?? []

  const done = (line: NewLine): void => {
    onAdd(line)
    setText('')
    setChoosing(null)
    setFailed(false)
  }

  const pick = async (id: string): Promise<void> => {
    setFailed(false)
    const found = results.find(item => item.id === id)
    if (found?.matchedVariant) {
      return done(
        lineOf(
          { id: found.id, name: found.name, sku: found.sku, priceCents: found.priceCents },
          found.matchedVariant
        )
      )
    }
    try {
      const product = await queryClient.fetchQuery({
        queryKey: QueryKeys.products.byId(storeId, id),
        queryFn: ({ signal }) => fetchProduct(apiClient, storeId, id, signal)
      })
      const variants = product.variants.filter(variant => variant.active)
      if (variants.length === 0) return done(lineOf(product, null))
      setChoosing(product)
    } catch {
      setFailed(true)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="order-product-search">{t('searchLabel')}</Label>
      <Input
        id="order-product-search"
        type="search"
        autoComplete="off"
        placeholder={t('searchPlaceholder')}
        value={text}
        onChange={event => {
          setText(event.target.value)
          setChoosing(null)
        }}
      />
      {failed ? (
        <p role="alert" className="text-destructive text-sm">
          {t('variantFailed')}
        </p>
      ) : null}
      {search.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {t('failedSearch')}
        </p>
      ) : null}
      {choosing !== null ? (
        <div
          role="group"
          aria-label={t('chooseVariant', { name: choosing.name })}
          className="flex flex-col gap-1"
        >
          <p className="text-sm font-medium">{t('chooseVariant', { name: choosing.name })}</p>
          <ul className="flex flex-col gap-1">
            {choosing.variants
              .filter(variant => variant.active)
              .map(variant => (
                <li key={variant.id}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => done(lineOf(choosing, variant))}
                  >
                    {variant.name}
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      ) : q.length >= 2 && search.isSuccess && results.length === 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('noResults')}
        </p>
      ) : results.length > 0 && q.length >= 2 ? (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label={t('searchLabel')}>
          {results.map(item => (
            <li key={item.id}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto w-full justify-start py-2 text-left"
                onClick={() => void pick(item.id)}
              >
                <span className="flex flex-col items-start">
                  <span>{item.name}</span>
                  {item.matchedVariant !== null || item.sku !== null ? (
                    <span className="text-muted-foreground text-xs">
                      {[item.matchedVariant?.name, item.matchedVariant?.sku ?? item.sku]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  ) : null}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
