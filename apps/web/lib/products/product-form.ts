import type {
  ProductChanges,
  ProductDetailView,
  ProductInput,
  ProductVariantView,
  VariantChanges,
  VariantInput
} from '@platform/api-client'
import { ProductLimits } from '@platform/core/domain'

import { centsToInput, parseCents } from './money'

// The words of the form, as the person typed them. The fields that are numbers stay text until they are sent.
export interface ProductFormValues {
  name: string
  sku: string
  description: string
  price: string
  cost: string
  trackInventory: boolean
  // Empty = no low stock alert
  lowStockThreshold: string
  freeShipping: boolean
  active: boolean
}

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  name: '',
  sku: '',
  description: '',
  price: '',
  cost: '',
  trackInventory: true,
  lowStockThreshold: '',
  freeShipping: false,
  active: true
}

export function formFromProduct(product: ProductDetailView): ProductFormValues {
  return {
    name: product.name,
    sku: product.sku ?? '',
    description: product.description ?? '',
    price: centsToInput(product.priceCents),
    cost: product.costCents === null ? '' : centsToInput(product.costCents),
    trackInventory: product.trackInventory,
    lowStockThreshold: product.lowStockThreshold === null ? '' : String(product.lowStockThreshold),
    freeShipping: product.freeShipping,
    active: product.active
  }
}

// The field the form points at when it cannot be sent
export type ProductFormField = 'name' | 'price' | 'cost' | 'lowStockThreshold'

export type FormResult<T> = { ok: true; value: T } | { ok: false; field: ProductFormField }

const THRESHOLD = /^\d{1,7}$/

// The alert threshold as typed: empty is no alert (null), a whole number up to the limit is the threshold, and anything
// else is undefined (wrong)
export function thresholdOf(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!THRESHOLD.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value <= ProductLimits.MAX_LOW_STOCK_THRESHOLD ? value : undefined
}

interface Parsed {
  name: string
  priceCents: number
  costCents: number | null
  lowStockThreshold: number | null
}

// `withCost` is whether the person holds `products:view_cost`: without it the cost is not read from the form
// (its field is not drawn) and never leaves it, whatever the values hold.
function parse(values: ProductFormValues, withCost: boolean): FormResult<Parsed> {
  const name = values.name.trim()
  if (name === '') return { ok: false, field: 'name' }
  const priceCents = parseCents(values.price)
  if (priceCents === null) return { ok: false, field: 'price' }
  const costCents = withCost && values.cost.trim() !== '' ? parseCents(values.cost) : null
  if (withCost && values.cost.trim() !== '' && costCents === null) {
    return { ok: false, field: 'cost' }
  }
  // The field is drawn only for a product that tracks its stock: what is in it means nothing otherwise
  const lowStockThreshold = values.trackInventory ? thresholdOf(values.lowStockThreshold) : null
  if (lowStockThreshold === undefined) return { ok: false, field: 'lowStockThreshold' }
  return { ok: true, value: { name, priceCents, costCents, lowStockThreshold } }
}

// A new product: what is empty is left out, so the catalog's own defaults apply
export function productInputFrom(
  values: ProductFormValues,
  withCost: boolean
): FormResult<ProductInput> {
  const parsed = parse(values, withCost)
  if (!parsed.ok) return parsed
  const { name, priceCents, costCents, lowStockThreshold } = parsed.value
  const sku = values.sku.trim()
  const description = values.description.trim()
  return {
    ok: true,
    value: {
      name,
      priceCents,
      ...(costCents === null ? {} : { costCents }),
      ...(sku === '' ? {} : { sku }),
      ...(description === '' ? {} : { description }),
      trackInventory: values.trackInventory,
      ...(lowStockThreshold === null ? {} : { lowStockThreshold }),
      active: values.active,
      freeShipping: values.freeShipping
    }
  }
}

// An edit: only what differs from the product, so a field that was not touched is never overwritten. An
// emptied SKU, description, cost or threshold clears it.
export function productChangesFrom(
  product: ProductDetailView,
  values: ProductFormValues,
  withCost: boolean
): FormResult<ProductChanges> {
  const parsed = parse(values, withCost)
  if (!parsed.ok) return parsed
  const { name, priceCents, costCents, lowStockThreshold } = parsed.value
  const sku = values.sku.trim() === '' ? null : values.sku.trim()
  const description = values.description.trim() === '' ? null : values.description.trim()
  const changes: ProductChanges = {}
  if (name !== product.name) changes.name = name
  if (sku !== product.sku) changes.sku = sku
  if (description !== product.description) changes.description = description
  if (priceCents !== product.priceCents) changes.priceCents = priceCents
  if (withCost && costCents !== product.costCents) changes.costCents = costCents
  if (values.trackInventory !== product.trackInventory) {
    changes.trackInventory = values.trackInventory
  }
  // A product that stops tracking its stock keeps the threshold it had: the field is hidden, not cleared
  if (values.trackInventory && lowStockThreshold !== product.lowStockThreshold) {
    changes.lowStockThreshold = lowStockThreshold
  }
  if (values.freeShipping !== product.freeShipping) changes.freeShipping = values.freeShipping
  if (values.active !== product.active) changes.active = values.active
  return { ok: true, value: changes }
}

export interface VariantFormValues {
  name: string
  sku: string
  // Empty = the price of the product
  price: string
  // Empty = the cost of the product
  cost: string
}

export const EMPTY_VARIANT_FORM: VariantFormValues = { name: '', sku: '', price: '', cost: '' }

export function formFromVariant(variant: ProductVariantView): VariantFormValues {
  return {
    name: variant.name,
    sku: variant.sku ?? '',
    price: variant.priceCents === null ? '' : centsToInput(variant.priceCents),
    cost: variant.costCents === null ? '' : centsToInput(variant.costCents)
  }
}

export type VariantFormField = 'name' | 'price' | 'cost'
export type VariantResult<T> = { ok: true; value: T } | { ok: false; field: VariantFormField }

function variantParts(
  values: VariantFormValues,
  withCost: boolean
): VariantResult<{ name: string; priceCents: number | null; costCents: number | null }> {
  const name = values.name.trim()
  if (name === '') return { ok: false, field: 'name' }
  const priceCents = values.price.trim() === '' ? null : parseCents(values.price)
  if (values.price.trim() !== '' && priceCents === null) return { ok: false, field: 'price' }
  const costCents = withCost && values.cost.trim() !== '' ? parseCents(values.cost) : null
  if (withCost && values.cost.trim() !== '' && costCents === null) {
    return { ok: false, field: 'cost' }
  }
  return { ok: true, value: { name, priceCents, costCents } }
}

export function variantInputFrom(
  values: VariantFormValues,
  withCost: boolean
): VariantResult<VariantInput> {
  const parts = variantParts(values, withCost)
  if (!parts.ok) return parts
  const sku = values.sku.trim()
  return {
    ok: true,
    value: {
      name: parts.value.name,
      ...(sku === '' ? {} : { sku }),
      ...(parts.value.priceCents === null ? {} : { priceCents: parts.value.priceCents }),
      ...(parts.value.costCents === null ? {} : { costCents: parts.value.costCents })
    }
  }
}

export function variantChangesFrom(
  variant: ProductVariantView,
  values: VariantFormValues,
  withCost: boolean
): VariantResult<VariantChanges> {
  const parts = variantParts(values, withCost)
  if (!parts.ok) return parts
  const sku = values.sku.trim() === '' ? null : values.sku.trim()
  const changes: VariantChanges = {}
  if (parts.value.name !== variant.name) changes.name = parts.value.name
  if (sku !== variant.sku) changes.sku = sku
  if (parts.value.priceCents !== variant.priceCents) changes.priceCents = parts.value.priceCents
  if (withCost && parts.value.costCents !== variant.costCents) {
    changes.costCents = parts.value.costCents
  }
  return { ok: true, value: changes }
}
