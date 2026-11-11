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
import { type DraftLine, draftLineKey, parseQuantity } from '../../lib/transfers/transfer-form'
import { useErrorText } from '../../lib/use-error-text'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// The autocomplete of the products of one store (the draft of a transfer holds items of the stores of whoever makes it)
const MIN_CHARS = 2
const RESULTS = 8

// Adds items to a draft: search by name or SKU in a store, pick the product (and its variant when it has them), say
// how many units, add. The quantity is checked here, so a line never enters the draft with units that make no sense.
// The picker lives inside the form of the draft: Enter in its boxes must not save the draft
const keepEnterHere = (event: KeyboardEvent<HTMLInputElement>): void => {
  if (event.key === 'Enter') event.preventDefault()
}

export function ItemPicker({
  stores,
  onAdd
}: {
  stores: readonly { id: string; name: string }[]
  onAdd: (line: DraftLine) => void
}): ReactElement {
  const t = useTranslations('transfers.picker')
  const errorText = useErrorText()
  const ids = useId()
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '')
  const [text, setText] = useState('')
  const [units, setUnits] = useState('1')
  const [wrongUnits, setWrongUnits] = useState(false)
  const [choosing, setChoosing] = useState<ProductDetailView | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Which pick may still answer: a new search, another store or another pick makes an older one stale
  const pickToken = useRef(0)
  const q = useDeferredValue(text.trim())
  const search = useQuery({
    queryKey: QueryKeys.transfers.picker(storeId, q),
    queryFn: ({ signal }) =>
      searchProducts(apiClient, storeId, { q, includeArchived: false, limit: RESULTS }, signal),
    enabled: storeId !== '' && q.length >= MIN_CHARS
  })

  const add = (
    item: ProductSearchItemView,
    variant: { id: string; name: string; sku: string | null } | null
  ): void => {
    const quantity = parseQuantity(units)
    if (quantity === null) {
      setWrongUnits(true)
      return
    }
    const matched = variant ?? item.matchedVariant
    onAdd({
      key: draftLineKey(item.id, matched?.id ?? null),
      storeId,
      productId: item.id,
      variantId: matched?.id ?? null,
      productName: item.name,
      variantName: matched?.name ?? null,
      sku: matched?.sku ?? item.sku,
      quantity: String(quantity)
    })
    setText('')
    setChoosing(null)
    setWrongUnits(false)
  }

  const pick = (item: ProductSearchItemView): void => {
    setFailure(null)
    pickToken.current += 1
    const token = pickToken.current
    if (item.matchedVariant !== null) {
      add(item, null)
      return
    }
    // A product that has variants is moved by variant: the search names one only when the text matched it
    fetchProduct(apiClient, storeId, item.id).then(
      detail => {
        if (token !== pickToken.current) return
        const variants = detail.variants.filter(variant => variant.active)
        if (variants.length === 0) add(item, null)
        else setChoosing({ ...detail, variants })
      },
      (error: unknown) => {
        if (token === pickToken.current) setFailure(errorText(error))
      }
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <p className="text-sm font-medium">{t('heading')}</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <div className="grid gap-1.5">
          {stores.length > 1 ? (
            <>
              <Label htmlFor={`${ids}-store`}>{t('store')}</Label>
              <select
                id={`${ids}-store`}
                className={SELECT_CLASS}
                value={storeId}
                onChange={event => {
                  pickToken.current += 1
                  setStoreId(event.target.value)
                  setChoosing(null)
                }}
              >
                {stores.map(store => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
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
        <div className="grid content-end gap-1.5">
          <Label htmlFor={`${ids}-units`}>{t('units')}</Label>
          <Input
            id={`${ids}-units`}
            inputMode="numeric"
            onKeyDown={keepEnterHere}
            value={units}
            aria-invalid={wrongUnits}
            aria-describedby={wrongUnits ? `${ids}-units-error` : undefined}
            onChange={event => {
              setUnits(event.target.value)
              setWrongUnits(false)
            }}
          />
        </div>
      </div>
      {wrongUnits ? (
        <p id={`${ids}-units-error`} role="alert" className="text-destructive text-sm">
          {t('wrongUnits')}
        </p>
      ) : null}
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
                    add(
                      {
                        id: choosing.id,
                        name: choosing.name,
                        sku: choosing.sku,
                        priceCents: choosing.priceCents,
                        imageMediaId: choosing.imageMediaId,
                        active: choosing.active,
                        matchedVariant: null
                      },
                      variant
                    )
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
}): ReactElement | null {
  const t = useTranslations('transfers.picker')
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
