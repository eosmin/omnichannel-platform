import { z } from 'zod'

import { type Permission, Permissions } from '@platform/core/auth'
import { CustomerLimits } from '@platform/core/domain'
import { downloadAllBodySchema } from '@platform/core/storage'

import { conversationFilterSchema } from '../conversations/conversations.schemas'

// What an export row keeps in `Export.filters`. The row crosses the database as JSON, so the worker
// reads it back through these schemas and refuses what does not fit.

export const customersExportFiltersSchema = z.strictObject({
  q: z.string().min(1).max(CustomerLimits.SEARCH_MAX_LENGTH).optional()
})
export type CustomersExportFilters = z.output<typeof customersExportFiltersSchema>

// The permissions that decide what a viewer of conversations sees (conversations.support.ts). The
// export is written later by the worker, with nobody asking, so the requester is frozen in the row:
// the permissions are those of the request, the assignment of each conversation is read when the file is made (a known limit, written in the plan).
const VIEW_PERMISSIONS: readonly Permission[] = [
  Permissions.CONVERSATIONS_VIEW,
  Permissions.CONVERSATIONS_VIEW_ALL,
  Permissions.CONVERSATIONS_ARCHIVE
]

export function viewPermissionsOf(held: readonly Permission[]): Permission[] {
  return VIEW_PERMISSIONS.filter(permission => held.includes(permission))
}

const viewerSchema = z.strictObject({
  userId: z.uuid(),
  held: z.array(z.enum(VIEW_PERMISSIONS as [Permission, ...Permission[]]))
})

export const conversationsExportFiltersSchema = z.strictObject({
  filter: conversationFilterSchema,
  viewer: viewerSchema
})
export type ConversationsExportFilters = z.output<typeof conversationsExportFiltersSchema>

// The ZIP of a gallery holds the files of the conversations the requester could see when they asked
export const mediaZipFiltersSchema = downloadAllBodySchema.extend({ viewer: viewerSchema })
export type MediaZipFilters = z.output<typeof mediaZipFiltersSchema>
