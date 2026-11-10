import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'

// The api drops the cost keys for a caller without `products:view_cost` (PR A2), so a missing key reads as
// null. The schema cannot know the permission: the screen decides whether to draw cost from the permission,
// never from the value.
const costSchema = z
  .number()
  .int()
  .nullish()
  .transform(value => value ?? null)

// What GET /products and /products/:id answer. Money is whole USD cents (never a float); a variant with
// no price of its own has `priceCents: null` and sells at the price of its product.
const variantSchema = z.object({
  id: z.string(),
  productId: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  priceCents: z.number().int().nullable(),
  effectivePriceCents: z.number().int(),
  costCents: costSchema,
  effectiveCostCents: costSchema,
  attributes: z.record(z.string(), z.string()),
  active: z.boolean(),
  createdAt: z.string()
})
export type ProductVariantView = z.output<typeof variantSchema>

const productFields = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number().int(),
  costCents: costSchema,
  sku: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  trackInventory: z.boolean(),
  lowStockThreshold: z.number().int().nullable(),
  active: z.boolean(),
  freeShipping: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
}

const productListItemSchema = z.object({ ...productFields, variantCount: z.number().int() })
export type ProductListItemView = z.output<typeof productListItemSchema>

const productDetailSchema = z.object({ ...productFields, variants: z.array(variantSchema) })
export type ProductDetailView = z.output<typeof productDetailSchema>

const productPageSchema = z.object({
  data: z.array(productListItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type ProductPageView = z.output<typeof productPageSchema>

// The links of a picture are asked apart (GET /media/:id): this is the file, not where it is served from
const productImageSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  fileSize: z.number().int(),
  status: z.string(),
  createdAt: z.string()
})
export type ProductImageView = z.output<typeof productImageSchema>

// A product sent to POST /products. What is left out takes the default of the catalog; `null` is only for
// what may be cleared (the cost, the low stock threshold).
export interface ProductInput {
  name: string
  priceCents: number
  description?: string | null
  costCents?: number | null
  sku?: string
  trackInventory?: boolean
  lowStockThreshold?: number | null
  active?: boolean
  freeShipping?: boolean
}

// PATCH /products/:id: only the fields sent change. `imageMediaId` is the cover (a live picture of the
// product, or null for none).
export type ProductChanges = Partial<Omit<ProductInput, 'sku'>> & {
  sku?: string | null
  imageMediaId?: string | null
}

export interface VariantInput {
  name: string
  sku?: string
  priceCents?: number | null
  costCents?: number | null
  attributes?: Record<string, string>
  active?: boolean
}
export type VariantChanges = Partial<Omit<VariantInput, 'sku'>> & { sku?: string | null }

export interface ProductListParams {
  active?: boolean
  cursor?: string | null
  limit?: number
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value)
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export function fetchProducts(
  client: ApiClient,
  storeId: string,
  params: ProductListParams,
  signal?: AbortSignal
): Promise<ProductPageView> {
  const search = query({
    active: params.active === undefined ? undefined : String(params.active),
    cursor: params.cursor ?? undefined,
    limit: params.limit === undefined ? undefined : String(params.limit)
  })
  return client.request(`${ApiRoutes.products.list}${search}`, {
    schema: productPageSchema,
    storeId,
    signal
  })
}

export function fetchProduct(
  client: ApiClient,
  storeId: string,
  productId: string,
  signal?: AbortSignal
): Promise<ProductDetailView> {
  return client.request(ApiRoutes.products.byId(productId), {
    schema: productDetailSchema,
    storeId,
    signal
  })
}

export function createProduct(
  client: ApiClient,
  storeId: string,
  input: ProductInput
): Promise<ProductDetailView> {
  return client.request(ApiRoutes.products.create, {
    method: 'POST',
    body: input,
    schema: productDetailSchema,
    storeId
  })
}

export function updateProduct(
  client: ApiClient,
  storeId: string,
  productId: string,
  changes: ProductChanges
): Promise<ProductDetailView> {
  return client.request(ApiRoutes.products.byId(productId), {
    method: 'PATCH',
    body: changes,
    schema: productDetailSchema,
    storeId
  })
}

// 409 `has_history` when an order, a stock movement or a live file names the product: archive it instead
export function deleteProduct(
  client: ApiClient,
  storeId: string,
  productId: string
): Promise<void> {
  return client.request(ApiRoutes.products.byId(productId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

export function fetchProductImages(
  client: ApiClient,
  storeId: string,
  productId: string,
  signal?: AbortSignal
): Promise<ProductImageView[]> {
  return client.request(ApiRoutes.products.images(productId), {
    schema: z.array(productImageSchema),
    storeId,
    signal
  })
}

export function createVariant(
  client: ApiClient,
  storeId: string,
  productId: string,
  input: VariantInput
): Promise<ProductVariantView> {
  return client.request(ApiRoutes.products.variants(productId), {
    method: 'POST',
    body: input,
    schema: variantSchema,
    storeId
  })
}

export function updateVariant(
  client: ApiClient,
  storeId: string,
  productId: string,
  variantId: string,
  changes: VariantChanges
): Promise<ProductVariantView> {
  return client.request(ApiRoutes.products.variantById(productId, variantId), {
    method: 'PATCH',
    body: changes,
    schema: variantSchema,
    storeId
  })
}

export function deleteVariant(
  client: ApiClient,
  storeId: string,
  productId: string,
  variantId: string
): Promise<void> {
  return client.request(ApiRoutes.products.variantById(productId, variantId), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

// GET /products/search: the autocomplete. A product answers either by its own name or SKU or by one of its
// variants, which it then names in `matchedVariant`.
const searchItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  priceCents: z.number().int(),
  imageMediaId: z.string().nullable(),
  active: z.boolean(),
  matchedVariant: z
    .object({
      id: z.string(),
      name: z.string(),
      sku: z.string().nullable(),
      priceCents: z.number().int().nullable(),
      effectivePriceCents: z.number().int()
    })
    .nullable()
})
export type ProductSearchItemView = z.output<typeof searchItemSchema>

const searchResultSchema = z.object({ data: z.array(searchItemSchema) })

export function searchProducts(
  client: ApiClient,
  storeId: string,
  params: { q: string; includeArchived: boolean; limit?: number },
  signal?: AbortSignal
): Promise<ProductSearchItemView[]> {
  const search = query({
    q: params.q,
    includeArchived: String(params.includeArchived),
    limit: params.limit === undefined ? undefined : String(params.limit)
  })
  return client
    .request(`${ApiRoutes.products.search}${search}`, {
      schema: searchResultSchema,
      storeId,
      signal
    })
    .then(result => result.data)
}
