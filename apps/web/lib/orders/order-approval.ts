import { isDiscountWithinLimit } from '@platform/core/domain'

import { parseCents } from '../products/money'

import { parseQuantity, shownPriceCents, type DraftLine } from './order-form'

// What the create drawer tells about the price of the order before it is sent (TDD_17 §4.13). The server decides: this is
// only the same rule read early, so that nobody is surprised by "waiting for approval" after saving.
export const DiscountHints = {
  // No discount typed, or one that does not read as an amount yet
  NONE: 'none',
  // A member who may override prices: the discount needs no approval, and the approvers may be told
  OVERRIDDEN: 'overridden',
  WITHIN_LIMIT: 'within_limit',
  NEEDS_APPROVAL: 'needs_approval',
  // The limit of the store cannot be read (no `settings:view`): nothing is said about it
  UNKNOWN: 'unknown'
} as const

export type DiscountHint = (typeof DiscountHints)[keyof typeof DiscountHints]

// The subtotal the form would send: the price of each line (the one typed, when the member may write it) by its units
export function estimatedSubtotalCents(
  lines: readonly DraftLine[],
  canOverridePrice: boolean
): number {
  return lines.reduce((sum, line) => {
    const typed = canOverridePrice && line.priceText !== null ? parseCents(line.priceText) : null
    return sum + (typed ?? shownPriceCents(line)) * (parseQuantity(line.quantity) ?? 0)
  }, 0)
}

export function discountHint(input: {
  discountText: string
  subtotalCents: number
  canOverridePrice: boolean
  // The `orders.discountLimitPercent` of the store, null when the member cannot read the preferences
  limitPercent: number | null
}): DiscountHint {
  const discountCents = input.discountText.trim() === '' ? 0 : parseCents(input.discountText)
  if (discountCents === null || discountCents <= 0) return DiscountHints.NONE
  if (input.canOverridePrice) return DiscountHints.OVERRIDDEN
  if (input.limitPercent === null) return DiscountHints.UNKNOWN
  return isDiscountWithinLimit(discountCents, input.subtotalCents, input.limitPercent)
    ? DiscountHints.WITHIN_LIMIT
    : DiscountHints.NEEDS_APPROVAL
}
