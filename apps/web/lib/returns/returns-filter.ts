import type { ListReturnsParams } from '@platform/api-client'
import { OrderReturnStatus, ReturnListLimits } from '@platform/core/domain'

// The filters of the list of returns as plain values, and what is sent for them. The api checks the same and decides.

export interface ReturnsFilterDraft {
  // Null is any state
  status: OrderReturnStatus | null
  // The number of the order as the store prints it
  orderNumber: string
  // Calendar days as `YYYY-MM-DD` ('' is open)
  createdFrom: string
  createdTo: string
}

export const EMPTY_RETURNS_FILTER: ReturnsFilterDraft = {
  status: null,
  orderNumber: '',
  createdFrom: '',
  createdTo: ''
}

export const ReturnsFilterProblems = {
  RANGE_BACKWARDS: 'rangeBackwards',
  ORDER_NUMBER_TOO_LONG: 'orderNumberTooLong'
} as const
export type ReturnsFilterProblem =
  (typeof ReturnsFilterProblems)[keyof typeof ReturnsFilterProblems]

export function returnsFilterProblems(draft: ReturnsFilterDraft): ReturnsFilterProblem[] {
  const problems: ReturnsFilterProblem[] = []
  if (draft.createdFrom !== '' && draft.createdTo !== '' && draft.createdFrom > draft.createdTo) {
    problems.push(ReturnsFilterProblems.RANGE_BACKWARDS)
  }
  if (draft.orderNumber.trim().length > ReturnListLimits.ORDER_NUMBER_MAX_LENGTH) {
    problems.push(ReturnsFilterProblems.ORDER_NUMBER_TOO_LONG)
  }
  return problems
}

export const isReturnsFiltered = (draft: ReturnsFilterDraft): boolean =>
  draft.status !== null ||
  draft.orderNumber.trim() !== '' ||
  draft.createdFrom !== '' ||
  draft.createdTo !== ''

// Only what is set: an empty field is not a filter
export function returnsListParams(
  draft: ReturnsFilterDraft
): Pick<ListReturnsParams, 'status' | 'orderNumber' | 'createdFrom' | 'createdTo'> {
  const params: Pick<ListReturnsParams, 'status' | 'orderNumber' | 'createdFrom' | 'createdTo'> = {}
  if (draft.status !== null) params.status = draft.status
  if (draft.orderNumber.trim() !== '') params.orderNumber = draft.orderNumber.trim()
  if (draft.createdFrom !== '') params.createdFrom = draft.createdFrom
  if (draft.createdTo !== '') params.createdTo = draft.createdTo
  return params
}

// A state of the select that this version does not know is not a state
const KNOWN_STATUSES: readonly string[] = Object.values(OrderReturnStatus)
export const asReturnsStatusFilter = (value: string): OrderReturnStatus | null =>
  KNOWN_STATUSES.includes(value) ? (value as OrderReturnStatus) : null
