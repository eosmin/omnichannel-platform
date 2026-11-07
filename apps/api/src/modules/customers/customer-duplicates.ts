import type { PrismaService } from '@platform/core/database'
import { CustomerLimits, DuplicateMatches, type DuplicateMatch } from '@platform/core/domain'

import type { PossibleDuplicate } from './customers.views'

export interface DuplicateKey {
  email: string | null
  phoneDigits: string | null
}

interface Row {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  createdAt: Date
}

// A customer of the store that shares the e-mail or the phone of the one just created. It is a hint:
// the customer is created anyway (two people can share a number), and the agent decides whether to merge.
//
// Only this store's customers, never one that a merge absorbed or an erasure emptied (they are not
// customers any more). One bounded query per key, so that a mailbox shared by many customers cannot
// fill every slot and hide the one with the same phone; the reason a customer is listed is the query
// that found it, not a second comparison. The e-mail is compared as a whole, without regard to case
// (`lower(email) = lower(...)`, never a pattern: an underscore or a percent sign in an address is
// itself). The ones that match on both come first, then the newest, at most DUPLICATE_HINTS_MAX.
export async function findPossibleDuplicates(
  db: PrismaService['client'],
  storeId: string,
  key: DuplicateKey,
  excludeId: string
): Promise<PossibleDuplicate[]> {
  const limit = CustomerLimits.DUPLICATE_HINTS_MAX
  const [byEmail, byPhone] = await Promise.all([
    key.email === null
      ? Promise.resolve<Row[]>([])
      : db.$queryRaw<Row[]>`
          SELECT id, name, email, phone, created_at AS "createdAt" FROM customers
          WHERE store_id = ${storeId} AND id <> ${excludeId}
            AND merged_into_id IS NULL AND erased_at IS NULL
            AND lower(email) = lower(${key.email})
          ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    key.phoneDigits === null
      ? Promise.resolve<Row[]>([])
      : db.customer.findMany({
          where: {
            storeId,
            id: { not: excludeId },
            mergedIntoId: null,
            erasedAt: null,
            phoneNormalized: key.phoneDigits
          },
          select: { id: true, name: true, email: true, phone: true, createdAt: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit
        })
  ])

  const found = new Map<string, { row: Row; matchedOn: DuplicateMatch[] }>()
  const add = (rows: Row[], matched: DuplicateMatch): void => {
    for (const row of rows) {
      const known = found.get(row.id)
      if (known === undefined) found.set(row.id, { row, matchedOn: [matched] })
      else known.matchedOn.push(matched)
    }
  }
  add(byEmail, DuplicateMatches.EMAIL)
  add(byPhone, DuplicateMatches.PHONE)

  // Both reasons first; then a shared phone before a shared e-mail (a mailbox is often shared by a
  // whole team, a phone number seldom is); then the newest
  const weight = (matchedOn: DuplicateMatch[]): number =>
    matchedOn.length * 2 + (matchedOn.includes(DuplicateMatches.PHONE) ? 1 : 0)
  return [...found.values()]
    .sort(
      (a, b) =>
        weight(b.matchedOn) - weight(a.matchedOn) ||
        b.row.createdAt.getTime() - a.row.createdAt.getTime() ||
        (a.row.id < b.row.id ? 1 : -1)
    )
    .slice(0, limit)
    .map(({ row, matchedOn }) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      matchedOn
    }))
}
