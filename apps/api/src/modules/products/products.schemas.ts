import { z } from 'zod'

import {
  PaginationLimits,
  ProductLimits,
  ProductSearchConfig,
  singleLineText
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = z.uuid()

// Postgres text cannot hold a NUL character: it is a 400 here and not a 500 there
const description = z
  .string()
  .trim()
  .max(ProductLimits.DESCRIPTION_MAX_LENGTH)
  .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })

const name = singleLineText(ProductLimits.NAME_MAX_LENGTH, 1)
const sku = singleLineText(ProductLimits.SKU_MAX_LENGTH, 1)
const variantName = singleLineText(ProductLimits.VARIANT_NAME_MAX_LENGTH, 1)
// Whole USD cents: a price with a fraction of a cent is a mistake and not a rounding
const cents = z.number().int().min(0).max(ProductLimits.MAX_AMOUNT_CENTS)
const lowStockThreshold = z.number().int().min(0).max(ProductLimits.MAX_LOW_STOCK_THRESHOLD)

const attributes = z
  .record(
    singleLineText(ProductLimits.ATTRIBUTE_KEY_MAX_LENGTH, 1),
    singleLineText(ProductLimits.ATTRIBUTE_VALUE_MAX_LENGTH, 1)
  )
  .refine(value => Object.keys(value).length <= ProductLimits.MAX_ATTRIBUTES, {
    message: `at most ${ProductLimits.MAX_ATTRIBUTES} attributes`
  })

// The query string says "true" or "false"
const flag = z.enum(['true', 'false']).transform(value => value === 'true')

export const listProductsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  active: flag.optional()
})

export const createProductSchema = z.strictObject({
  name,
  description: description.nullable().optional(),
  priceCents: cents,
  costCents: cents.nullable().optional(),
  sku: sku.optional(),
  trackInventory: z.boolean().optional(),
  lowStockThreshold: lowStockThreshold.nullable().optional(),
  active: z.boolean().optional(),
  freeShipping: z.boolean().optional()
})

const notEmpty = (body: object): boolean => Object.values(body).some(value => value !== undefined)

export const updateProductSchema = z
  .strictObject({
    name: name.optional(),
    description: description.nullable().optional(),
    priceCents: cents.optional(),
    costCents: cents.nullable().optional(),
    sku: sku.nullable().optional(),
    trackInventory: z.boolean().optional(),
    lowStockThreshold: lowStockThreshold.nullable().optional(),
    active: z.boolean().optional(),
    freeShipping: z.boolean().optional()
  })
  .refine(notEmpty, { message: 'nothing to change' })

export const createVariantSchema = z.strictObject({
  name: variantName,
  sku: sku.optional(),
  // Null, or no price, is the price of the product
  priceCents: cents.nullable().optional(),
  costCents: cents.nullable().optional(),
  attributes: attributes.optional(),
  active: z.boolean().optional()
})

export const updateVariantSchema = z
  .strictObject({
    name: variantName.optional(),
    sku: sku.nullable().optional(),
    priceCents: cents.nullable().optional(),
    costCents: cents.nullable().optional(),
    attributes: attributes.optional(),
    active: z.boolean().optional()
  })
  .refine(notEmpty, { message: 'nothing to change' })

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>
export type CreateProductBody = z.infer<typeof createProductSchema>
export type UpdateProductBody = z.infer<typeof updateProductSchema>
export type CreateVariantBody = z.infer<typeof createVariantSchema>
export type UpdateVariantBody = z.infer<typeof updateVariantSchema>

// What the autocomplete asks: a text (it may be empty or short: the answer is then an empty list), how many
// rows, and whether archived products and variants count
export const searchProductsQuerySchema = z.strictObject({
  q: z
    .string()
    .trim()
    .max(ProductSearchConfig.MAX_QUERY_LENGTH)
    .refine(value => !value.includes('\0'), { message: 'contains a NUL character' }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ProductSearchConfig.MAX_LIMIT)
    .default(ProductSearchConfig.DEFAULT_LIMIT),
  includeArchived: flag.default(false)
})

export type SearchProductsQuery = z.infer<typeof searchProductsQuerySchema>
