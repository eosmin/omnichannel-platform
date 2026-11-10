import { z } from 'zod'

import {
  InventoryLimits,
  PaginationLimits,
  singleLineText,
  WarehouseLimits
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const idSchema = z.uuid()

const name = singleLineText(InventoryLimits.WAREHOUSE_NAME_MAX_LENGTH, 1)
// ASCII only, no spaces: the code is printed on documents and typed at a counter. The database holds the same rule,
// and compares it ignoring letter case.
const code = z.string().regex(WarehouseLimits.CODE_PATTERN)

const addressField = singleLineText(WarehouseLimits.ADDRESS_FIELD_MAX_LENGTH, 1)
const address = z.strictObject({
  line1: addressField,
  line2: addressField.optional(),
  city: addressField,
  state: addressField.optional(),
  postalCode: addressField.optional(),
  // Two letters, kept in capitals
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform(value => value.toUpperCase())
    .optional()
})

// The query string says "true" or "false"
const flag = z.enum(['true', 'false']).transform(value => value === 'true')

export const listWarehousesQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  active: flag.optional()
})

export const createWarehouseSchema = z.strictObject({
  name,
  code,
  address: address.optional()
})

export const updateWarehouseSchema = z
  .strictObject({
    name: name.optional(),
    code: code.optional(),
    address: address.nullable().optional(),
    active: z.boolean().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

// The stores a warehouse serves, as the complete list: a store left out is unlinked. A priority is where the warehouse
// stands in that store's list (1 is reserved first); without one it keeps its place, or goes to the end if it is new.
export const putWarehouseStoresSchema = z.strictObject({
  stores: z
    .array(
      z.strictObject({
        storeId: z.uuid(),
        priority: z.number().int().min(1).max(WarehouseLimits.MAX_STORES_PER_REQUEST).optional()
      })
    )
    .max(WarehouseLimits.MAX_STORES_PER_REQUEST)
    .refine(links => new Set(links.map(link => link.storeId)).size === links.length, {
      message: 'a store is named once'
    })
})

export type ListWarehousesQuery = z.infer<typeof listWarehousesQuerySchema>
export type CreateWarehouseBody = z.infer<typeof createWarehouseSchema>
export type UpdateWarehouseBody = z.infer<typeof updateWarehouseSchema>
export type PutWarehouseStoresBody = z.infer<typeof putWarehouseStoresSchema>
