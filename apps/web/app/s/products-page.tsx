'use client'

import { Plus, Search, TriangleAlert } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useMemo, useState } from 'react'

import type {
  ProductListItemView,
  ProductSearchItemView,
  StockSummaryView
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { SearchPageParams } from '@platform/core/domain'

import type { ProductTarget } from '../../components/products/product-sheet'
import { useStore } from '../../components/providers/store-context'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useStockSummaries } from '../../lib/inventory/use-stock-summaries'
import { formatCents } from '../../lib/products/money'
import { matchesFilter } from '../../lib/products/product-filter'
import { matchesProduct } from '../../lib/products/product-search'
import {
  ProductFilters,
  type ProductFilter,
  SEARCH_MIN_CHARS,
  useProductList,
  useProductSearch
} from '../../lib/products/use-products'
import { useDebouncedValue } from '../../lib/use-debounced-value'
import { useMountedOnce } from '../../lib/use-mounted-once'

// The panel loads when the first product is opened (or a new one asked for): the form, the pictures and the
// variants are not needed to read the list
const SEARCH_DELAY_MS = 250

const ProductSheet = dynamic(
  () => import('../../components/products/product-sheet').then(module => module.ProductSheet),
  { ssr: false }
)

// What a row shows, whether it comes from the list or from the search of the api
interface RowView {
  id: string
  name: string
  sku: string | null
  priceCents: number
  active: boolean
  // The variants of the product, or (a search answer) the one that matched
  variants: { count: number } | { matched: string | null }
}

const fromList = (product: ProductListItemView): RowView => ({
  id: product.id,
  name: product.name,
  sku: product.sku,
  priceCents: product.priceCents,
  active: product.active,
  variants: { count: product.variantCount }
})

const fromSearch = (product: ProductSearchItemView): RowView => ({
  id: product.id,
  name: product.name,
  sku: product.sku,
  priceCents: product.priceCents,
  active: product.active,
  variants: { matched: product.matchedVariant?.name ?? null }
})

// What the stock column says of a product: how many are available, the warning when it is at its alert threshold, or
// that it keeps no count. Nothing while the answer for the page is on its way.
function StockCell({ stock }: { stock: StockSummaryView | undefined }): ReactElement | null {
  const t = useTranslations('products.stock.list')
  if (stock === undefined) return null
  if (!stock.trackInventory) return <span className="text-muted-foreground">{t('notTracked')}</span>
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <span className="tabular-nums">{t('available', { count: stock.available })}</span>
      {stock.isLow ? (
        <span className="flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">
          <TriangleAlert aria-hidden className="size-3.5" />
          {t('low')}
        </span>
      ) : null}
    </span>
  )
}

function Row({
  product,
  onOpen,
  stock,
  showStock
}: {
  product: RowView
  onOpen: () => void
  stock: StockSummaryView | undefined
  showStock: boolean
}): ReactElement {
  const t = useTranslations('products')
  const format = useFormatter()
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3">
        <Button
          variant="ghost"
          className="h-auto max-w-full justify-start px-1 py-0.5 font-medium"
          onClick={onOpen}
        >
          <span className="truncate">{product.name}</span>
        </Button>
      </td>
      <td className="text-muted-foreground py-2 pr-3 text-sm">{product.sku ?? ''}</td>
      <td className="py-2 pr-3 text-sm whitespace-nowrap">
        {formatCents(format, product.priceCents)}
      </td>
      <td className="py-2 pr-3 text-sm">
        {'count' in product.variants ? product.variants.count : (product.variants.matched ?? '')}
      </td>
      {showStock ? (
        <td className="py-2 pr-3 text-sm">
          <StockCell stock={stock} />
        </td>
      ) : null}
      <td className="py-2 text-sm">{product.active ? t('status.active') : t('status.archived')}</td>
    </tr>
  )
}

// The catalog of the store: a table with a filter by state, a page at a time, each product opening its panel.
// From two characters the search box asks the autocomplete of the api (a product also answers for the name or
// SKU of one of its variants); with fewer it narrows the rows already loaded.
export function ProductsPage(): ReactElement {
  const t = useTranslations('products')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const params = useSearchParams()
  const [filter, setFilter] = useState<ProductFilter>(ProductFilters.ALL)
  // The page a product hit of the search opens: the catalog with the name already in the box
  const addressText = params.get(SearchPageParams.QUERY) ?? ''
  const [text, setText] = useState(addressText)
  // A product hit chosen while the catalog is already open changes the address, not the page: the box follows it
  useEffect(() => setText(addressText), [addressText])
  const [target, setTarget] = useState<ProductTarget | null>(null)
  // The panel is downloaded when it is first asked for and stays mounted, so that it can close with its animation
  const isSheetLoaded = useMountedOnce(target !== null)
  const mayView = can(ClientPermissions.PRODUCTS_VIEW)
  const mayReadStock = can(ClientPermissions.INVENTORY_VIEW)
  const products = useProductList(storeId, filter, mayView)
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS)
  const typed = text.trim()
  const isSearching = typed.length >= SEARCH_MIN_CHARS
  const search = useProductSearch(storeId, q, filter, mayView)
  const loaded = products.data?.pages.flatMap(page => page.data) ?? []
  // The rows of an earlier text stay on the screen, dimmed, until the answer for the current one arrives
  const isStale = isSearching && (q !== typed || search.isPlaceholderData)
  const rows: RowView[] = isSearching
    ? (search.data ?? []).filter(product => matchesFilter(filter, product.active)).map(fromSearch)
    : loaded.filter(product => matchesProduct(product, text)).map(fromList)

  // The stock of the products on the screen, asked together: one request for each hundred of them
  const idsKey = rows.map(row => row.id).join(',')
  const shownIds = useMemo(() => (idsKey === '' ? [] : idsKey.split(',')), [idsKey])
  const stock = useStockSummaries(storeId, shownIds, mayView && mayReadStock)

  if (!mayView) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-sm">
          {t('noAccess')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">{t('title')}</h1>
        {can(ClientPermissions.PRODUCTS_CREATE) ? (
          <Button size="sm" onClick={() => setTarget({ kind: 'new' })}>
            <Plus aria-hidden />
            {t('newProduct')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-md">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4"
          />
          <Input
            type="search"
            className="pl-8"
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            value={text}
            onChange={event => setText(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="products-filter" className="sr-only">
            {t('filter.label')}
          </Label>
          <select
            id="products-filter"
            className={SELECT_CLASS}
            value={filter}
            onChange={event => setFilter(event.target.value as ProductFilter)}
          >
            {Object.values(ProductFilters).map(value => (
              <option key={value} value={value}>
                {t(`filter.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(isSearching ? search.isPending : products.isPending) ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : null}
      {(isSearching ? search.isError : products.isError && loaded.length === 0) ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void (isSearching ? search.refetch() : products.refetch())}
          >
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {!isSearching && products.isSuccess && loaded.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : null}
      {isSearching && search.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noMatches')}</p>
      ) : null}
      {!isSearching && loaded.length > 0 && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {products.hasNextPage ? t('noMatchesYet') : t('noMatches')}
        </p>
      ) : null}

      {rows.length === 0 ? null : (
        <div
          className={isStale ? 'overflow-x-auto opacity-60' : 'overflow-x-auto'}
          aria-busy={isStale}
        >
          <table className="w-full text-left">
            <thead>
              <tr className="border-b text-sm">
                <th className="py-2 pr-3 font-medium">{t('columns.name')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.sku')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.price')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.variants')}</th>
                {mayReadStock ? (
                  <th className="py-2 pr-3 font-medium">{t('columns.stock')}</th>
                ) : null}
                <th className="py-2 font-medium">{t('columns.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(product => (
                <Row
                  key={product.id}
                  product={product}
                  onOpen={() => setTarget({ kind: 'product', id: product.id })}
                  stock={stock.byProduct.get(product.id)}
                  showStock={mayReadStock}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mayReadStock && stock.isError ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('stock.list.failed')}
        </p>
      ) : null}
      {!isSearching && products.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={products.isFetchingNextPage}
          busy={products.isFetchingNextPage}
          onClick={() => void products.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}

      {isSheetLoaded ? (
        <ProductSheet target={target} onSelect={setTarget} onClose={() => setTarget(null)} />
      ) : null}
    </div>
  )
}
