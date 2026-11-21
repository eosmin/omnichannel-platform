import type { PrismaService, SqlReader } from '@platform/core/database'
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
  // A customer who was erased (Step 7.2) is a name that is gone: the list and the export do not carry the row
  erasedAt: null
}

export function customerSearchWhere(storeId: string): CustomerSearchWhere {
  return { storeId, mergedIntoId: null, erasedAt: null }
}

// The orders a page of the customers a search finds can come in: the list (newest first) and the export (by id)
export const CustomerSearchOrders = { NEWEST: 'newest', ID: 'id' } as const

// A page of the customers a search finds: where it starts (the list is newest first, the export by id) and how many
export type CustomerSearchPage =
  | {
      order: typeof CustomerSearchOrders.NEWEST
      after: { createdAt: Date; id: string } | undefined
      limit: number
    }
  | { order: typeof CustomerSearchOrders.ID; after: string | undefined; limit: number }

// The ids of one page of the customers a search finds, in the order of the page. It runs inside the context of ONE store (the
// function reads the store from it and raises without one): the one of the request when it is open, or its own for the store
export function searchCustomerIds(
  prisma: PrismaService,
  storeId: string,
  patterns: CustomerSearchPatterns,
  page: CustomerSearchPage
): Promise<string[]> {
  return prisma.inStoreContext(storeId, () => readCustomerIds(prisma.client, patterns, page))
}

async function readCustomerIds(
  db: SqlReader,
  patterns: CustomerSearchPatterns,
  page: CustomerSearchPage
): Promise<string[]> {
  const byId = page.order === CustomerSearchOrders.ID
  const afterId = byId ? (page.after ?? null) : (page.after?.id ?? null)
  // As ISO text: the function reads it as the (UTC) moment the column holds, whatever the time zone of the session
  const afterAt =
    page.order === CustomerSearchOrders.NEWEST
      ? (page.after?.createdAt.toISOString() ?? null)
      : null
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT f.id FROM public.rls_search_customer_list(
      ${patterns.name}::text, ${patterns.email}::text, ${patterns.phone}::text, ${byId}::boolean,
      ${afterAt}::text, ${afterId}::text, ${page.limit}::integer
    ) AS f`
  return rows.map(row => row.id)
}

// How many customers a search finds, in the context of one store
export function countCustomerSearch(
  prisma: PrismaService,
  storeId: string,
  patterns: CustomerSearchPatterns
): Promise<number> {
  return prisma.inStoreContext(storeId, async () => {
    const rows = await prisma.client.$queryRaw<{ n: bigint }[]>`
    SELECT public.rls_count_customer_list(
      ${patterns.name}::text, ${patterns.email}::text, ${patterns.phone}::text
    ) AS n`
    return Number(rows[0]?.n ?? 0n)
  })
}
