'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import {
  confirmUpload,
  createProduct,
  createVariant,
  deleteProduct,
  deleteVariant,
  fetchProduct,
  fetchProductImages,
  fetchProducts,
  type ProductChanges,
  type ProductDetailView,
  type ProductImageView,
  type ProductInput,
  type ProductPageView,
  type ProductVariantView,
  type ProductSearchItemView,
  QueryKeys,
  requestUploadUrl,
  searchProducts,
  updateProduct,
  updateVariant,
  type VariantChanges,
  type VariantInput
} from '@platform/api-client'
import { MediaPurpose } from '@platform/core/storage'

import { apiClient } from '../api'
import { uploadToUrl } from '../media/upload-to-url'

import { ProductFilters, type ProductFilter } from './product-filter'

export { ProductFilters, type ProductFilter }

const ACTIVE_OF: Record<ProductFilter, boolean | undefined> = {
  [ProductFilters.ALL]: undefined,
  [ProductFilters.ACTIVE]: true,
  [ProductFilters.ARCHIVED]: false
}

// How often the pictures are read again while one waits for its scan (the file shows only when clean)
const PENDING_POLL_MS = 3000

export function useProductList(
  storeId: string,
  filter: ProductFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<ProductPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.products.list(storeId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchProducts(apiClient, storeId, { active: ACTIVE_OF[filter], cursor: pageParam }, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    enabled
  })
}

// The minimum the api answers a search for: shorter is the list of the page, not a search
export const SEARCH_MIN_CHARS = 2

// The autocomplete of the api, for the search box of the page. `q` is the text already trimmed and
// debounced by the caller; under the minimum nothing is asked. The Active filter asks the api to leave the
// archived ones out (so the cap of the answer is spent on products that can show); All and Archived ask for
// them, and Archived narrows after (the api has no archived-only mode).
export function useProductSearch(
  storeId: string,
  q: string,
  filter: ProductFilter,
  enabled: boolean
): UseQueryResult<ProductSearchItemView[]> {
  const includeArchived = filter !== ProductFilters.ACTIVE
  return useQuery({
    queryKey: QueryKeys.products.search(storeId, q, includeArchived),
    queryFn: ({ signal }) => searchProducts(apiClient, storeId, { q, includeArchived }, signal),
    enabled: enabled && q.length >= SEARCH_MIN_CHARS,
    placeholderData: keepPreviousData
  })
}

export function useProduct(
  storeId: string,
  productId: string | null
): UseQueryResult<ProductDetailView> {
  return useQuery({
    queryKey: QueryKeys.products.byId(storeId, productId ?? ''),
    queryFn: ({ signal }) => fetchProduct(apiClient, storeId, productId ?? '', signal),
    enabled: productId !== null
  })
}

export function useProductImages(
  storeId: string,
  productId: string
): UseQueryResult<ProductImageView[]> {
  return useQuery({
    queryKey: QueryKeys.products.images(storeId, productId),
    queryFn: ({ signal }) => fetchProductImages(apiClient, storeId, productId, signal),
    refetchInterval: query =>
      query.state.data?.some(image => image.status !== 'clean') === true ? PENDING_POLL_MS : false
  })
}

export interface ProductWrites {
  create: UseMutationResult<ProductDetailView, Error, ProductInput>
  update: UseMutationResult<ProductDetailView, Error, ProductChanges>
  remove: UseMutationResult<void, Error, void>
}

// Every write makes the catalog stale (the list shows the name, the price, the count of variants and the
// state) and the product with its variants and pictures. A product that was just created has no id to
// change yet: `productId` is null until the sheet shows it.
export function useProductWrites(storeId: string, productId: string | null): ProductWrites {
  const queryClient = useQueryClient()
  const refresh = async (): Promise<void> => {
    // The stock column says "low" by the alert threshold of the product, and an untracked product has no count: both
    // are changed here
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: QueryKeys.products.all(storeId) }),
      queryClient.invalidateQueries({ queryKey: QueryKeys.inventory.all(storeId) })
    ])
  }
  const create = useMutation({
    mutationFn: (input: ProductInput) => createProduct(apiClient, storeId, input),
    onSuccess: refresh
  })
  const update = useMutation({
    mutationFn: (changes: ProductChanges) =>
      updateProduct(apiClient, storeId, productId ?? '', changes),
    onSuccess: refresh
  })
  const remove = useMutation({
    mutationFn: () => deleteProduct(apiClient, storeId, productId ?? ''),
    onSuccess: refresh
  })
  return { create, update, remove }
}

export interface VariantWrites {
  add: UseMutationResult<ProductVariantView, Error, VariantInput>
  edit: UseMutationResult<ProductVariantView, Error, { variantId: string; changes: VariantChanges }>
  remove: UseMutationResult<void, Error, string>
}

export function useVariantWrites(storeId: string, productId: string): VariantWrites {
  const queryClient = useQueryClient()
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: QueryKeys.products.all(storeId) })
  }
  const add = useMutation({
    mutationFn: (input: VariantInput) => createVariant(apiClient, storeId, productId, input),
    onSuccess: refresh
  })
  const edit = useMutation({
    mutationFn: ({ variantId, changes }: { variantId: string; changes: VariantChanges }) =>
      updateVariant(apiClient, storeId, productId, variantId, changes),
    onSuccess: refresh
  })
  const remove = useMutation({
    mutationFn: (variantId: string) => deleteVariant(apiClient, storeId, productId, variantId),
    onSuccess: refresh
  })
  return { add, edit, remove }
}

// A picture of the product, by the flow of every upload (a signed url, the bytes straight to the bucket, a
// confirmation): the purpose `product` names the product, and the api checks it belongs to the store and that
// the member may edit products. The scan then runs; the picture shows when it is clean.
export function useProductImageUpload(
  storeId: string,
  productId: string
): UseMutationResult<void, Error, File> {
  const queryClient = useQueryClient()
  // Closing the panel or leaving the page stops an upload that is still sending bytes
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  return useMutation({
    mutationFn: async (file: File) => {
      const info = { filename: file.name, contentType: file.type, fileSizeBytes: file.size }
      const target = { purpose: MediaPurpose.PRODUCT, parentId: productId } as const
      const signed = await requestUploadUrl(apiClient, storeId, info, target)
      controller.current = new AbortController()
      await uploadToUrl(
        signed.uploadUrl,
        file,
        file.type,
        () => undefined,
        controller.current.signal
      )
      await confirmUpload(
        apiClient,
        storeId,
        { ...info, mediaId: signed.mediaId, key: signed.key },
        target
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QueryKeys.products.byId(storeId, productId) })
    }
  })
}
