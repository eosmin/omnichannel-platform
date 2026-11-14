import { z } from 'zod'

import { CarrierLocationLimits, PaginationLimits, uuidSchema } from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

export const connectionIdSchema = uuidSchema

// One page of the connections of the store, in order of creation. A cursor that is not ours, or a limit out of range, is a
// malformed query (400), not an empty page.
export const listCarriersQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
})
export type ListCarriersQuery = z.output<typeof listCarriersQuerySchema>

// The places of a carrier under one parent, optionally narrowed by a name. The parent id is the carrier's own and ends up in a cache
// key, so it is held to the characters such ids are made of; a search is only text to look for, never sent to the carrier.
export const carrierLocationParentIdSchema = z
  .string()
  .min(1)
  .max(CarrierLocationLimits.ID_MAX_LENGTH)
  .regex(CarrierLocationLimits.ID_PATTERN)
export const listLocationsQuerySchema = z.strictObject({
  parentId: carrierLocationParentIdSchema.optional(),
  search: z.string().max(CarrierLocationLimits.SEARCH_MAX_LENGTH).optional()
})
export type ListLocationsQuery = z.output<typeof listLocationsQuerySchema>
