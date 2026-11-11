'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  createStockAdjustment,
  fetchKardex,
  fetchProductInventory,
  fetchStockLevels,
  fetchWarehousesOfStore,
  type KardexParams,
  type ProductInventoryView,
  QueryKeys,
  updateProduct,
  type StockAdjustmentInput,
  type StockAdjustmentView,
  type StockLevelFilter,
  type StockLevelPageView,
  type StockMovementPageView,
  type WarehouseView
} from '@platform/api-client'

import { apiClient } from '../api'

export function useProductInventory(
  storeId: string,
  productId: string,
  enabled: boolean
): UseQueryResult<ProductInventoryView> {
  return useQuery({
    queryKey: QueryKeys.inventory.product(storeId, productId),
    queryFn: ({ signal }) => fetchProductInventory(apiClient, storeId, productId, signal),
    enabled
  })
}

// The warehouses the store sells from, for the adjustment to name one
export function useWarehousesOfStore(
  storeId: string,
  enabled: boolean
): UseQueryResult<WarehouseView[]> {
  return useQuery({
    queryKey: QueryKeys.inventory.warehouses(storeId),
    queryFn: ({ signal }) => fetchWarehousesOfStore(apiClient, storeId, signal),
    enabled
  })
}

// The kardex of one item in one warehouse, a page at a time, newest first. `item` is null until one is chosen.
export function useKardex(
  storeId: string,
  item: Omit<KardexParams, 'cursor' | 'limit'> | null
): UseInfiniteQueryResult<InfiniteData<StockMovementPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.inventory.kardex(
      storeId,
      item?.productId ?? '',
      item?.variantId ?? null,
      item?.warehouseId ?? ''
    ),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchKardex(
        apiClient,
        storeId,
        { ...(item as NonNullable<typeof item>), cursor: pageParam, limit: KARDEX_PAGE },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    enabled: item !== null
  })
}

export const KARDEX_PAGE = 20

// An adjustment makes every stock number of the store stale: the levels, the kardex, the column of the catalog
export function useStockAdjustment(
  storeId: string
): UseMutationResult<StockAdjustmentView, Error, StockAdjustmentInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: StockAdjustmentInput) => createStockAdjustment(apiClient, storeId, input),
    // The numbers are made stale and read again in the background: the dialog does not wait for them
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.all(storeId) })
    }
  })
}

export const STOCK_PAGE = 30

// Every level of the store, a page at a time, in the order and with the filters of the screen
export function useStockLevels(
  storeId: string,
  filter: StockLevelFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<StockLevelPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.inventory.levelList(storeId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchStockLevels(
        apiClient,
        storeId,
        { ...filter, cursor: pageParam, limit: STOCK_PAGE },
        signal
      ),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    // A page that is already on the screen stays until the new filter answers
    placeholderData: previous => previous,
    enabled
  })
}

// The alert threshold of a product (null: no alert). It is a field of the product, so the catalog goes stale too.
export function useThresholdChange(
  storeId: string
): UseMutationResult<unknown, Error, { productId: string; lowStockThreshold: number | null }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { productId: string; lowStockThreshold: number | null }) =>
      updateProduct(apiClient, storeId, input.productId, {
        lowStockThreshold: input.lowStockThreshold
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.all(storeId) })
      void queryClient.invalidateQueries({ queryKey: QueryKeys.products.all(storeId) })
    }
  })
}
