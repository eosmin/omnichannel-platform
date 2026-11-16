import { FinanceLimits } from '@platform/core/domain'

// The money of the books is whole cents of US dollars and never a float (TDD_18 §2). A sum that can pass the 32 bits of a line
// arrives as a string of digits, so the text of an amount is made from the digits and not from a number.

const DIGITS = /^-?\d+$/

// 12345 -> "123.45"; "-5" -> "-0.05". An amount that is not whole cents is refused, so no screen draws a guess.
export function decimalOfCents(cents: string | number): string {
  const text = typeof cents === 'number' ? String(cents) : cents
  if (!DIGITS.test(text)) throw new Error('an amount is whole cents')
  const negative = text.startsWith('-')
  const digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, '').padStart(3, '0')
  const whole = digits.slice(0, -2)
  return `${negative && /[1-9]/.test(digits) ? '-' : ''}${whole}.${digits.slice(-2)}`
}

// The text of an amount in the language of the person: US$ 15.50. Intl reads the decimal text exactly (no float in between).
const formatters = new Map<string, Intl.NumberFormat>()

export function moneyText(locale: string, cents: string | number): string {
  let formatter = formatters.get(locale)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' })
    formatters.set(locale, formatter)
  }
  return formatter.format(decimalOfCents(cents) as unknown as number)
}

// A rate is kept in basis points: 13 % is 1300. 1250 -> "12.5", 1300 -> "13", 125 -> "1.25"
export function percentOfBps(bps: number): string {
  const whole = Math.trunc(bps / 100)
  const rest = bps % 100
  if (rest === 0) return String(whole)
  return `${String(whole)}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}

// "13" -> 1300, "12.5" -> 1250, "0.01" -> 1; more than two decimals, a sign or a letter is not a rate (null)
export function bpsOfPercentText(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim())
  if (match === null) return null
  const whole = Number(match[1])
  const rest = Number((match[2] ?? '').padEnd(2, '0'))
  return whole * 100 + rest
}

// "1234.56" -> 123456, "-0,5" -> -50: what a person types as an amount, in whole cents. No thousands separator, no more than two decimals
// and nothing that does not fit the 32 bits of an amount of the books is an amount (null); the arithmetic is on whole numbers.
export function centsOfDecimalText(input: string, maxCents = 2_147_483_647): number | null {
  const match = /^(-?)(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(input.trim())
  if (match === null) return null
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents > maxCents) return null
  return match[1] === '-' && cents !== 0 ? -cents : cents
}

// What a person types as an amount of a transaction or a line: the same reading, but only above zero and within a line of the books
// ("12" -> 1200, "0.05" -> 5); a sign, zero or more than a line can hold is not an amount (null).
export function positiveCentsOfDecimalText(input: string): number | null {
  const cents = centsOfDecimalText(input, FinanceLimits.MAX_LINE_CENTS)
  return cents !== null && cents >= 1 ? cents : null
}
