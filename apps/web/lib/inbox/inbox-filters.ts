import type { ConversationFilters } from '@platform/api-client'
import {
  channelIdSchema,
  ConversationAssignedFilters,
  ConversationStatus,
  uuidSchema
} from '@platform/core/domain'

// The filters of the list live in the address (?assigned=me&status=OPEN&channelType=whatsapp&tagId=...), so
// that a view can be shared and survives a reload. What the address carries is text anyone can type:
// a value that is not valid is dropped, never sent to the api.
// The names of the filters in the address, so that a change leaves every other parameter alone
export const FILTER_PARAMS = ['assigned', 'status', 'channelType', 'tagId'] as const

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

  const tagId = params.get('tagId')
  if (tagId !== null && uuidSchema.safeParse(tagId).success) filters.tagId = tagId.toLowerCase()

  return filters
}

export function paramsFromFilters(filters: ConversationFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.assigned !== undefined) params.set('assigned', filters.assigned)
  if (filters.status !== undefined) params.set('status', filters.status)
  if (filters.channelType !== undefined) params.set('channelType', filters.channelType)
  if (filters.tagId !== undefined) params.set('tagId', filters.tagId)
  return params
}

export const hasFilters = (filters: ConversationFilters): boolean => Object.keys(filters).length > 0

// "With draft" is not a filter of the api: the drafts live in this tab, so it is kept in the address (a reload keeps
// the view, as the drafts stay in the tab) apart from the filters, and nothing of it is sent to the server
export const DRAFT_FILTER_PARAM = 'draft'
const DRAFT_FILTER_ON = '1'

export const onlyDraftsFromParams = (params: URLSearchParams): boolean =>
  params.get(DRAFT_FILTER_PARAM) === DRAFT_FILTER_ON

// The query kept on the links to a conversation: the filters and, if it is on, the draft view
export function searchOf(filters: ConversationFilters, onlyDrafts: boolean): string {
  const params = paramsFromFilters(filters)
  if (onlyDrafts) params.set(DRAFT_FILTER_PARAM, DRAFT_FILTER_ON)
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export function withOnlyDrafts(params: URLSearchParams, onlyDrafts: boolean): URLSearchParams {
  const next = new URLSearchParams(params)
  if (onlyDrafts) next.set(DRAFT_FILTER_PARAM, DRAFT_FILTER_ON)
  else next.delete(DRAFT_FILTER_PARAM)
  return next
}
