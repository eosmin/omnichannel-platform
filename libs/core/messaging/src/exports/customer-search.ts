import type { PrismaService } from '@platform/core/database'
import { SearchConfig } from '@platform/core/domain'

import { escapeLike } from '../customers/customers.support'

// Digits, spaces and the punctuation a phone number is written with
const PHONE_LIKE = /^[\d\s+().-]+$/

// The customers of a store that a search text finds, absorbed ones left out. The list of customers
// and their export use the same rule, so the file holds the rows the screen shows.
export interface CustomerSearchWhere {
  storeId: string
  mergedIntoId: null
  OR?: Record<string, unknown>[]
}

// "Calle 123" is a street and "7123-4567" a phone: the digits are looked for in the phones only when nothing but
// digits and the punctuation of a phone was typed, and there are enough of them (a short run matches half the book).
// Empty when the text is not a phone: the customers list, its export and the search all read this one rule.
export function phoneDigitsOf(q: string): string {
  if (!PHONE_LIKE.test(q)) return ''
  const digits = q.replace(/\D/g, '')
  return digits.length >= SearchConfig.MIN_PHONE_DIGITS ? digits : ''
}

// The text as the database folds the stored names (`lower(immutable_unaccent(...))`, the rules of `unaccent`): asking the
// database is the only way to fold both sides the same way for every character. The empty string when the fold is empty.
export async function foldInDatabase(db: PrismaService['client'], q: string): Promise<string> {
  const rows = await db.$queryRaw<
    { folded: string }[]
  >`SELECT lower(immutable_unaccent(${q})) AS folded`
  return rows[0]?.folded ?? ''
}

// `folded` is the text folded by `foldInDatabase`; it is only read when there is a text
export function customerSearchWhere(
  storeId: string,
  q: string | undefined,
  folded: string
): CustomerSearchWhere {
  const text = q === undefined ? null : escapeLike(q)
  const digits = q === undefined ? '' : phoneDigitsOf(q)
  return {
    storeId,
    mergedIntoId: null,
    ...(text === null
      ? {}
      : {
          OR: [
            // Accent-insensitive: the column is the name with no accents and in lower case (migration
            // search_unaccent), so "jose" finds "José"; the text is folded the same way
            // A text that folds to nothing (only combining marks) is no name: `contains: ''` would match everybody
            ...(folded === '' ? [] : [{ nameSearch: { contains: escapeLike(folded) } }]),
            { email: { contains: text, mode: 'insensitive' as const } },
            ...(digits === '' ? [] : [{ phoneNormalized: { contains: digits } }])
          ]
        })
  }
}
