'use client'

import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'

import type { StockLevelView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { INVENTORY_SEARCH_MAX_LENGTH, InventoryLevelSorts } from '@platform/core/domain'

import { StockAdjustForLevel } from '../../components/inventory/stock-adjust-for-level'
import { StockLevelCard } from '../../components/inventory/stock-level-card'
import {
  StockThresholdDialog,
  type ThresholdTarget
} from '../../components/inventory/stock-threshold-dialog'
import { useStore } from '../../components/providers/store-context'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  EMPTY_STOCK_STATE,
  hasStockFilters,
  stockFilterOf
} from '../../lib/inventory/stock-filters'
import { useStockLevels, useWarehousesOfStore } from '../../lib/inventory/use-inventory'
import { useStockFilters } from '../../lib/inventory/use-stock-filters'
import { useDebouncedValue } from '../../lib/use-debounced-value'

const SEARCH_DELAY_MS = 250

// The stock of the whole store (TDD_16 §7): every item in every warehouse it sells from, a page at a time, by product
// name or by what changed last, with a search, a filter for the items that are low and one by warehouse. All of it is in
// the address, so the link of a low-stock notice opens the list already filtered. Each item opens its movements (the
// kardex), the adjustment and the alert threshold, with the same dialogs as the Stock tab of a product.
export function StockPage(): ReactElement {
  const t = useTranslations('stock')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const mayView = can(ClientPermissions.INVENTORY_VIEW)
  const mayAdjust = can(ClientPermissions.INVENTORY_ADJUST)
  const mayEditThreshold = can(ClientPermissions.PRODUCTS_EDIT)
  const { state, setState } = useStockFilters()
  const [text, setText] = useState(state.q)
  const typed = text.trim()
  const debounced = useDebouncedValue(typed, SEARCH_DELAY_MS)
  const levels = useStockLevels(storeId, stockFilterOf(state), mayView)
  const warehouses = useWarehousesOfStore(storeId, mayView)
  const [shownId, setShownId] = useState<string | null>(null)
  const [adjusting, setAdjusting] = useState<StockLevelView | null>(null)
  const [threshold, setThreshold] = useState<ThresholdTarget | null>(null)
  const rows = useMemo(() => levels.data?.pages.flatMap(page => page.data) ?? [], [levels.data])

  // The search goes to the address once the person stops typing: the box and the address never fight, because a text
  // that has not settled is not written (clearing the filters empties the box first)
  const written = useRef(state.q)
  useEffect(() => {
    if (debounced === typed && debounced !== state.q) {
      written.current = debounced
      setState({ q: debounced })
    }
  }, [debounced, typed, state.q, setState])
  // The address changed under the box (back, forward, the link of a notice): the box follows. What the box itself wrote
  // is not that: its echo can arrive after more typing, and must not erase it.
  useEffect(() => {
    if (state.q === written.current) return
    written.current = state.q
    setText(state.q)
  }, [state.q])

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

  const isFiltered = hasStockFilters(state)
  const isRefreshing = levels.isPlaceholderData
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>

      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
        <div className="relative w-full md:max-w-md">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4"
          />
          <Input
            type="search"
            className="pl-8"
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            maxLength={INVENTORY_SEARCH_MAX_LENGTH}
            value={text}
            onChange={event => setText(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="stock-warehouse-filter" className="sr-only">
            {t('filter.warehouse')}
          </Label>
          <select
            id="stock-warehouse-filter"
            className={SELECT_CLASS}
            value={state.warehouseId ?? ''}
            onChange={event => setState({ warehouseId: event.target.value || null })}
          >
            <option value="">{t('filter.allWarehouses')}</option>
            {(warehouses.data ?? []).map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="stock-sort" className="sr-only">
            {t('filter.sort')}
          </Label>
          <select
            id="stock-sort"
            className={SELECT_CLASS}
            value={state.sort}
            onChange={event => setState({ sort: event.target.value as typeof state.sort })}
          >
            <option value={InventoryLevelSorts.NAME}>{t('filter.sortName')}</option>
            <option value={InventoryLevelSorts.RECENT}>{t('filter.sortRecent')}</option>
          </select>
        </div>
        <label className="flex min-h-9 items-center gap-2 text-sm pointer-coarse:min-h-10">
          <input
            type="checkbox"
            className="size-4"
            checked={state.lowStock}
            onChange={event => setState({ lowStock: event.target.checked })}
          />
          {t('filter.lowStock')}
        </label>
        {isFiltered ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start md:self-end"
            onClick={() => {
              written.current = ''
              setText('')
              setState({ ...EMPTY_STOCK_STATE, sort: state.sort })
            }}
          >
            {t('filter.clear')}
          </Button>
        ) : null}
      </div>

      {levels.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : null}
      {levels.isError && rows.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button variant="outline" size="sm" onClick={() => void levels.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {levels.isError && rows.length > 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('refreshFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void levels.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {levels.isSuccess && rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {state.lowStock && state.q === '' && state.warehouseId === null
            ? t('emptyLow')
            : isFiltered
              ? t('noMatches')
              : t('empty')}
        </p>
      ) : null}

      {rows.length === 0 ? null : (
        <ul
          className={
            isRefreshing ? 'grid gap-3 opacity-60 lg:grid-cols-2' : 'grid gap-3 lg:grid-cols-2'
          }
          aria-busy={isRefreshing}
          // The rows of the earlier filter stay in view until the new ones arrive, but they do nothing meanwhile
          inert={isRefreshing}
          aria-label={t('listLabel')}
        >
          {rows.map(level => (
            <StockLevelCard
              key={level.id}
              level={level}
              isShown={shownId === level.id}
              isLow={state.lowStock}
              onToggleMovements={() => setShownId(shownId === level.id ? null : level.id)}
              onAdjust={mayAdjust ? () => setAdjusting(level) : null}
              onThreshold={
                mayEditThreshold
                  ? () =>
                      setThreshold({
                        productId: level.productId,
                        productName: level.productName,
                        threshold: level.lowStockThreshold
                      })
                  : null
              }
            />
          ))}
        </ul>
      )}
      {levels.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={levels.isFetchingNextPage}
          busy={levels.isFetchingNextPage}
          onClick={() => void levels.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}

      {mayAdjust ? (
        <StockAdjustForLevel level={adjusting} onClose={() => setAdjusting(null)} />
      ) : null}
      {mayEditThreshold ? (
        <StockThresholdDialog target={threshold} onClose={() => setThreshold(null)} />
      ) : null}
    </div>
  )
}
