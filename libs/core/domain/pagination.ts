// The shape of every list endpoint (TDD_08 §2.4). The cursor is opaque: where the next page starts (an endpoint may encode the last row's sort key and id, so that a row deleted meanwhile does not break the next page).
export interface CursorPage<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}

export const PaginationLimits = {
  DEFAULT: 25,
  MAX: 100
} as const
