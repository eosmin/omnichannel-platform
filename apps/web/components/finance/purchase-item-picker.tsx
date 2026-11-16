'use client'

import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type KeyboardEvent,
  type ReactElement,
  useDeferredValue,
  useId,
  useRef,
  useState
} from 'react'

import {
  fetchProduct,
  type ProductDetailView,
  type ProductSearchItemView,
  QueryKeys,
  searchProducts
} from '@platform/api-client'

import { apiClient } from '../../lib/api'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// What a line of a purchase names: the product and, when it has variants, the one bought
export interface PickedItem {
  productId: string
  variantId: string | null
  label: string
}

const MIN_CHARS = 2
const RESULTS = 8

// The picker lives inside the form of the order: Enter in its box must not save the lines
const keepEnterHere = (event: KeyboardEvent<HTMLInputElement>): void => {
  if (event.key === 'Enter') event.preventDefault()
}

// Adds an item to the lines of a draft order: search by name or SKU among the products of the store, pick one (and its variant when it
// has them). A purchase receives units, so a product that is not stocked is refused by the api when the order is saved.
export function PurchaseItemPicker({
  onPick
}: {
  onPick: (item: PickedItem) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.picker')
  const errorText = usePurchaseErrorText()
  const ids = useId()
  const { storeId } = useStore()
  const [text, setText] = useState('')
  const [choosing, setChoosing] = useState<ProductDetailView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Which pick may still answer: a new search or another pick makes an older one stale
  const pickToken = useRef(0)
  const q = useDeferredValue(text.trim())
  const search = useQuery({
    queryKey: QueryKeys.products.search(storeId, q, false),
    queryFn: ({ signal }) =>
      searchProducts(apiClient, storeId, { q, includeArchived: false, limit: RESULTS }, signal),
    enabled: q.length >= MIN_CHARS
  })

  const add = (item: PickedItem): void => {
    onPick(item)
    setText('')
    setChoosing(null)
  }

  const pick = (item: ProductSearchItemView): void => {
    setFailure(null)
    pickToken.current += 1
    const token = pickToken.current
    if (item.matchedVariant !== null) {
      add({
        productId: item.id,
        variantId: item.matchedVariant.id,
        label: `${item.name} · ${item.matchedVariant.name}`
      })
      return
    }
    // A product that has variants is bought by variant: the search names one only when the text matched it
    fetchProduct(apiClient, storeId, item.id).then(
      detail => {
        if (token !== pickToken.current) return
        const variants = detail.variants.filter(variant => variant.active)
        if (variants.length === 0) add({ productId: item.id, variantId: null, label: item.name })
        else setChoosing({ ...detail, variants })
      },
      (error: unknown) => {
        if (token === pickToken.current) setFailure(errorText(error))
      }
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="purchase-item-picker">
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-search`}>{t('search')}</Label>
        <Input
          id={`${ids}-search`}
          value={text}
          autoComplete="off"
          onKeyDown={keepEnterHere}
          onChange={event => {
            pickToken.current += 1
            setText(event.target.value)
            setChoosing(null)
          }}
        />
      </div>
      {failure === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      )}
      {choosing === null ? (
        <Results
          query={q}
          items={search.data}
          isLoading={search.isFetching}
          isError={search.isError}
          onPick={pick}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-sm">
            {t('chooseVariant', { name: choosing.name })}
          </p>
          <ul className="divide-y rounded-md border">
            {choosing.variants.map(variant => (
              <li key={variant.id}>
                <button
                  type="button"
                  className="hover:bg-accent flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm pointer-coarse:min-h-12"
                  onClick={() =>
                    add({
                      productId: choosing.id,
                      variantId: variant.id,
                      label: `${choosing.name} · ${variant.name}`
                    })
                  }
                >
                  <span>{variant.name}</span>
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    {variant.sku ?? ''}
                    <Plus aria-hidden className="size-4" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Results({
  query,
  items,
  isLoading,
  isError,
  onPick
}: {
  query: string
  items: ProductSearchItemView[] | undefined
  isLoading: boolean
  isError: boolean
  onPick: (item: ProductSearchItemView) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.picker')
  if (query.length < MIN_CHARS) {
    return <p className="text-muted-foreground text-sm">{t('hint', { count: MIN_CHARS })}</p>
  }
  if (isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('failed')}
      </p>
    )
  }
  if (items === undefined || isLoading) {
    return <p className="text-muted-foreground text-sm">{t('searching')}</p>
  }
  if (items.length === 0) return <p className="text-muted-foreground text-sm">{t('none')}</p>
  return (
    <ul className="divide-y rounded-md border">
      {items.map(item => (
        <li key={item.id}>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between rounded-none px-3 py-2 text-left font-normal pointer-coarse:min-h-12"
            onClick={() => onPick(item)}
          >
            <span className="flex flex-col items-start">
              <span>{item.name}</span>
              {item.matchedVariant === null ? null : (
                <span className="text-muted-foreground text-xs">{item.matchedVariant.name}</span>
              )}
            </span>
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              {item.matchedVariant?.sku ?? item.sku ?? ''}
              <Plus aria-hidden className="size-4" />
            </span>
          </Button>
        </li>
      ))}
    </ul>
  )
}
