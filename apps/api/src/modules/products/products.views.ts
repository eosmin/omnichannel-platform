import type { CursorPage } from '@platform/core/domain'

export interface VariantView {
  id: string
  productId: string
  name: string
  sku: string | null
  // Null = the price of the product; the one an order uses is `effectivePriceCents`
  priceCents: number | null
  effectivePriceCents: number
  // The cost fields are there only for a caller who holds products:view_cost (see `redactCost`): for the others the
  // keys are absent
  costCents?: number | null
  // The cost an order or a margin uses: the own cost, or the one of the product (null when neither has one)
  effectiveCostCents?: number | null
  attributes: Record<string, string>
  active: boolean
  createdAt: Date
}

export interface ProductItem {
  id: string
  name: string
  description: string | null
  priceCents: number
  costCents?: number | null
  sku: string | null
  imageMediaId: string | null
  trackInventory: boolean
  // Null = no low-stock alert for this product (TDD_16 §4.4)
  lowStockThreshold: number | null
  active: boolean
  freeShipping: boolean
  createdAt: Date
  updatedAt: Date
}

// A live picture of a product (not refused by the scan); its links are asked on GET /media/:id
export interface ProductImageView {
  id: string
  filename: string
  contentType: string
  fileSize: number
  status: string
  createdAt: Date
}

export interface ProductListItem extends ProductItem {
  variantCount: number
}

export interface ProductDetail extends ProductItem {
  variants: VariantView[]
}

export type ProductPage = CursorPage<ProductListItem>

export const PRODUCT_SELECT = {
  id: true,
  name: true,
  description: true,
  priceCents: true,
  costCents: true,
  sku: true,
  imageMediaId: true,
  trackInventory: true,
  lowStockThreshold: true,
  active: true,
  freeShipping: true,
  createdAt: true,
  updatedAt: true
} as const

export const VARIANT_SELECT = {
  id: true,
  productId: true,
  name: true,
  sku: true,
  priceCents: true,
  costCents: true,
  attributes: true,
  active: true,
  createdAt: true
} as const

interface VariantRow {
  id: string
  productId: string
  name: string
  sku: string | null
  priceCents: number | null
  costCents: number | null
  attributes: unknown
  active: boolean
  createdAt: Date
}

// What the column holds is written only by this module, as text to text, and read back as it was written
function attributesOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

export function variantView(
  row: VariantRow,
  product: { priceCents: number; costCents: number | null }
): VariantView {
  return {
    ...row,
    attributes: attributesOf(row.attributes),
    effectivePriceCents: row.priceCents ?? product.priceCents,
    effectiveCostCents: row.costCents ?? product.costCents
  }
}

// What the autocomplete shows of a product: enough to pick it and to price it, nothing more (no description, no
// cost). The picture is the id of the file; the client asks for its signed address as everywhere else.
export interface ProductSuggestion {
  id: string
  name: string
  sku: string | null
  priceCents: number
  imageMediaId: string | null
  active: boolean
  // The variant the text matched (its name or its sku), or null when the product matched by itself
  matchedVariant: {
    id: string
    name: string
    sku: string | null
    priceCents: number | null
    effectivePriceCents: number
  } | null
}

export interface ProductSuggestions {
  data: ProductSuggestion[]
}

// The cost of a product is the margin of the store (finance requirements, 2026-11-10): whoever does not hold
// products:view_cost gets the same views with the cost keys absent, on every read and in the answer to every write.
export function redactCost<T extends { costCents?: number | null }>(item: T): Omit<T, 'costCents'> {
  const copy: { costCents?: number | null } = { ...item }
  delete copy.costCents
  return copy as Omit<T, 'costCents'>
}

function redactVariant(variant: VariantView): VariantView {
  const copy: VariantView = { ...variant }
  delete copy.costCents
  delete copy.effectiveCostCents
  return copy
}

export function redactDetail(detail: ProductDetail): ProductDetail {
  return { ...redactCost(detail), variants: detail.variants.map(redactVariant) }
}

export function redactPage(page: ProductPage): ProductPage {
  return { ...page, data: page.data.map(redactCost) }
}

export { redactVariant }
