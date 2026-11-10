import type { useFormatter } from 'next-intl'

import { ProductLimits } from '@platform/core/domain'

// Money is whole US cents everywhere (the api refuses a fraction of a cent). Nothing here goes through a
// float: the text is split into dollars and cents and put together with integer arithmetic.
const AMOUNT = /^(\d{0,9})(?:[.,](\d{0,2}))?$/

// "15", "15.5", "15,50", ".5", "12." -> 1500, 1550, 1550, 50, 1200; null for anything else (a sign, a thousands separator, a third
// decimal, text) and for an amount over the limit of the catalog
export function parseCents(text: string): number | null {
  const trimmed = text.trim()
  const match = AMOUNT.exec(trimmed)
  // ".5" and "12." are amounts; "" and "." are not
  if (match === null || !/\d/.test(trimmed)) return null
  const dollars = Number(match[1])
  const cents = Number((match[2] ?? '').padEnd(2, '0'))
  const total = dollars * 100 + cents
  return total <= ProductLimits.MAX_AMOUNT_CENTS ? total : null
}

// 1550 -> "15.50": the text a price field starts with, with a point whatever the language (the field takes
// either separator back)
export function centsToInput(cents: number): string {
  const dollars = Math.trunc(cents / 100)
  const rest = cents % 100
  return `${dollars}.${String(rest).padStart(2, '0')}`
}

// The text of a price for the screen, in the language of the person: US$ 15.50. The amount is whole cents, split
// by 100 only to be handed to the formatter, which writes it with exactly two decimals.
export function formatCents(
  format: Pick<ReturnType<typeof useFormatter>, 'number'>,
  cents: number
): string {
  return format.number(cents / 100, { style: 'currency', currency: 'USD' })
}
