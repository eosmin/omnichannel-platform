import type { ConversationFilters } from '@platform/api-client'
import {
  channelIdSchema,
  ConversationAssignedFilters,
  ConversationStatus,
  uuidSchema
} from '@platform/core/domain'

// The filters of the list live in the address (?assigned=me&status=OPEN&channelType=whatsapp), so
// that a view can be shared and survives a reload. What the address carries is text anyone can type:
// a value that is not valid is dropped, never sent to the api.
// The names of the filters in the address, so that a change leaves every other parameter alone
export const FILTER_PARAMS = ['assigned', 'status', 'channelType'] as const

export function filtersFromParams(params: URLSearchParams): ConversationFilters {
  const filters: ConversationFilters = {}

  const assigned = params.get('assigned')
  if (
    assigned === ConversationAssignedFilters.ME ||
    assigned === ConversationAssignedFilters.UNASSIGNED
  ) {
    filters.assigned = assigned
  } else if (uuidSchema.safeParse(assigned).success && assigned !== null) {
    filters.assigned = assigned.toLowerCase()
  }

  const status = params.get('status')
  const knownStatus = Object.values(ConversationStatus).find(value => value === status)
  if (knownStatus !== undefined) filters.status = knownStatus

  const channelType = channelIdSchema.safeParse(params.get('channelType'))
  if (channelType.success) filters.channelType = channelType.data

  return filters
}

export function paramsFromFilters(filters: ConversationFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.assigned !== undefined) params.set('assigned', filters.assigned)
  if (filters.status !== undefined) params.set('status', filters.status)
  if (filters.channelType !== undefined) params.set('channelType', filters.channelType)
  return params
}

export const hasFilters = (filters: ConversationFilters): boolean => Object.keys(filters).length > 0
