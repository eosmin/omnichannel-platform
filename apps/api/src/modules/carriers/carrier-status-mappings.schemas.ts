import { z } from 'zod'

import {
  CarrierReportableStatuses,
  CarrierStatusLimits,
  isStorableProviderCode,
  normalizeProviderStatusCode,
  PaginationLimits,
  ShipmentStatus
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

// The code in the address: whatever the carrier calls it, normalized the way the webhook looks it up (so `Entregado ` and
// `entregádo` are one row), and a code that cannot be a column is refused, not cut
export const providerCodeSchema = z
  .string()
  .max(CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH * 2)
  .transform(normalizeProviderStatusCode)
  .refine(isStorableProviderCode, { message: 'not a status code' })

const REPORTABLE: ReadonlySet<ShipmentStatus> = new Set(CarrierReportableStatuses)

// Only a status a carrier can report is a target; the ones our own actions drive are not (TDD_17 §4.17). `null` is the
// owner's choice to ignore the code on purpose. The field is required: a PUT that says nothing is not a way to ignore.
export const putStatusMappingSchema = z.strictObject({
  status: z
    .enum(ShipmentStatus)
    .refine(status => REPORTABLE.has(status), { message: 'not a status a carrier can report' })
    .nullable()
})
export type PutStatusMappingBody = z.output<typeof putStatusMappingSchema>

// The mappings of a connection are listed by code, and the position is the code of the last row of the page
export const mappingCursorSchema = z.string().transform((text, ctx): string => {
  const code = Buffer.from(text, 'base64url').toString('utf8')
  if (
    providerCodeSchema.safeParse(code).success &&
    Buffer.from(code).toString('base64url') === text
  ) {
    return code
  }
  ctx.addIssue({ code: 'custom', message: 'not a cursor of this api' })
  return z.NEVER
})

export const listStatusMappingsQuerySchema = z.strictObject({
  cursor: mappingCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
})
export type ListStatusMappingsQuery = z.output<typeof listStatusMappingsQuerySchema>

export const listUnmappedStatusesQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
})
export type ListUnmappedStatusesQuery = z.output<typeof listUnmappedStatusesQuerySchema>

export const encodeMappingCursor = (code: string): string => Buffer.from(code).toString('base64url')
