// The receiver of a fiscal document as a LIST shows it, and as it is kept in the clear beside the sealed receiver (Step 7.3-S11b-2). A mask
// is personal data too, so it says as little as it can: a FIXED length (it never tells how long the original is), the first letter of the
// name and nothing more of it, and the last four digits of a tax id only when it has at least nine digits (a shorter number would show
// too much of itself). Pure: the same input is the same mask, and two tax ids that end in the same four digits have the same mask.
export const FiscalReceiverMask = {
  FILL: '*',
  // The length of every mask, whatever the length of the original
  LENGTH: 12,
  // The digits of a tax id that stay visible, and the fewest digits it must have for any to show
  TAX_ID_SHOWN: 4,
  TAX_ID_MIN_DIGITS: 9
} as const

// The first letter of the name (by code point: an accent or a character outside the basic plane is one) and the fill up to the fixed length;
// null for a name with no letters
export function maskReceiverName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null
  const first = Array.from(name.trim())[0]
  if (first === undefined) return null
  return first + FiscalReceiverMask.FILL.repeat(FiscalReceiverMask.LENGTH - 1)
}

// The last four DIGITS of a tax id with at least nine digits, after fill up to the fixed length; null when it has fewer (nothing is shown)
export function maskReceiverTaxId(taxId: string | null | undefined): string | null {
  if (taxId === null || taxId === undefined) return null
  const digits = taxId.replace(/\D/gu, '')
  if (digits.length < FiscalReceiverMask.TAX_ID_MIN_DIGITS) return null
  const shown = digits.slice(-FiscalReceiverMask.TAX_ID_SHOWN)
  return FiscalReceiverMask.FILL.repeat(FiscalReceiverMask.LENGTH - shown.length) + shown
}
