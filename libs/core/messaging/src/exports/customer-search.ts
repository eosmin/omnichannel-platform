import type { SqlReader } from '@platform/core/database'
import { SearchConfig } from '@platform/core/domain'

import { escapeLike } from '../customers/customers.support'

// Digits, spaces and the punctuation a phone number is written with
const PHONE_LIKE = /^[\d\s+().-]+$/

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
export async function foldInDatabase(db: SqlReader, q: string): Promise<string> {
  const rows = await db.$queryRaw<
    { folded: string }[]
  >`SELECT lower(immutable_unaccent(${q})) AS folded`
  return rows[0]?.folded ?? ''
}

// The text of a search as the patterns of the database function that finds the customers (migration rls_search_customer_list):
// contains-patterns, escaped, to be bound as parameters. `name` is null when the text folds to nothing (an empty LIKE would match
// everybody) and `phone` when the text is not a phone. The email is compared as typed: it is not a name and has no accents to fold.
export interface CustomerSearchPatterns {
  name: string | null
  email: string
  phone: string | null
}

// `folded` is the text folded by `foldInDatabase`
export function customerSearchPatterns(q: string, folded: string): CustomerSearchPatterns {
  const digits = phoneDigitsOf(q)
  return {
    name: folded === '' ? null : `%${escapeLike(folded)}%`,
    email: `%${escapeLike(q)}%`,
    phone: digits === '' ? null : `%${digits}%`
  }
}

// The customers of a store, absorbed ones left out. A search text does not filter here: the ids that the database function found
// are added (`id: { in }`), because under row-level security the LIKE of a search can only use its trigram indexes inside a
// definer function. The list of customers and their export use the same rule, so the file holds the rows the screen shows.
export interface CustomerSearchWhere {
  storeId: string
  mergedIntoId: null
}

export function customerSearchWhere(storeId: string): CustomerSearchWhere {
  return { storeId, mergedIntoId: null }
}

// A page of the customers a search finds: where it starts (the list is newest first, the export by id) and how many
export type CustomerSearchPage =
  | { order: 'newest'; after: { createdAt: Date; id: string } | undefined; limit: number }
  | { order: 'id'; after: string | undefined; limit: number }

// The ids of one page of the customers a search finds, in the order of the page. Runs inside the context of ONE store (the function
// reads the store from it and raises without one): the caller opens it with `inStoreContext`.
export async function searchCustomerIds(
  db: SqlReader,
  patterns: CustomerSearchPatterns,
  page: CustomerSearchPage
): Promise<string[]> {
  const byId = page.order === 'id'
  const afterId = byId ? (page.after ?? null) : (page.after?.id ?? null)
  // As ISO text: the function reads it as the (UTC) moment the column holds, whatever the time zone of the session
  const afterAt = page.order === 'newest' ? (page.after?.createdAt.toISOString() ?? null) : null
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT f.id FROM public.rls_search_customer_list(
      ${patterns.name}::text, ${patterns.email}::text, ${patterns.phone}::text, ${byId}::boolean,
      ${afterAt}::text, ${afterId}::text, ${page.limit}::integer
    ) AS f`
  return rows.map(row => row.id)
}

// How many customers a search finds, in the context of one store
export async function countCustomerSearch(
  db: SqlReader,
  patterns: CustomerSearchPatterns
): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT public.rls_count_customer_list(
      ${patterns.name}::text, ${patterns.email}::text, ${patterns.phone}::text
    ) AS n`
  return Number(rows[0]?.n ?? 0n)
}
