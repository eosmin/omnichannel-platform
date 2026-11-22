import { z } from 'zod'

import {
  AuditLogLimits,
  lowercasedUuidSchema,
  PaginationLimits,
  queryIntSchema
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

// The filters of the viewer and of the export. The store is never a field: it is the one of the request. A value that is not
// ours is a malformed query (400), not an empty page.
const filterFields = {
  action: z.string().min(1).max(AuditLogLimits.ACTION_MAX_LENGTH).optional(),
  userId: lowercasedUuidSchema.optional(),
  resourceType: z.string().min(1).max(AuditLogLimits.RESOURCE_TYPE_MAX_LENGTH).optional(),
  resourceId: z.string().min(1).max(AuditLogLimits.RESOURCE_ID_MAX_LENGTH).optional(),
  // Inclusive start and exclusive end of the range of the moment the entry was written
  from: z.iso.datetime().optional(),
  before: z.iso.datetime().optional()
}

const rangeIsOrdered = (value: { from?: string | undefined; before?: string | undefined }) =>
  value.from === undefined ||
  value.before === undefined ||
  new Date(value.from).getTime() < new Date(value.before).getTime()
const rangeIssue = { message: 'the start of the range is after its end', path: ['from'] }

export const listAuditLogQuerySchema = z
  .strictObject({
    ...filterFields,
    cursor: cursorSchema.optional(),
    limit: queryIntSchema(1, PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
  })
  .refine(rangeIsOrdered, rangeIssue)
export type ListAuditLogQuery = z.output<typeof listAuditLogQuerySchema>

export const exportAuditLogQuerySchema = z
  .strictObject(filterFields)
  .refine(rangeIsOrdered, rangeIssue)
export type ExportAuditLogQuery = z.output<typeof exportAuditLogQuerySchema>

// The instant of the entry, which the list shows: a read by id of an entry older than the hot window finds its month in the
// archive with it. Any other field is a malformed query.
export const auditLogEntryQuerySchema = z.strictObject({ at: z.iso.datetime().optional() })
export type AuditLogEntryQuery = z.output<typeof auditLogEntryQuerySchema>
