import { dsrEmailHash, normalizeDsrEmail } from '@platform/core/compliance'
import type { PrismaTransaction } from '@platform/core/database'

// The customers a data request names, looked at again at the moment of acting on them (TDD_05 §10.3). The rows are locked in id order, so a
// merge, an edit or an erasure of one of them waits. A customer that is already erased counts as done (the erasure is resumable); every other
// one must still be the person that asked: not merged away and with the address that made the request (compared by its keyed hash).
export type DsrSubjectCheck = { same: true; pending: string[]; erased: string[] } | { same: false }

export async function checkDsrSubject(
  tx: PrismaTransaction,
  storeId: string,
  ids: readonly string[],
  emailHash: string | null,
  hashKey: string
): Promise<DsrSubjectCheck> {
  if (ids.length === 0 || emailHash === null) return { same: false }
  const customers = await tx.$queryRaw<
    { id: string; email: string | null; erased_at: Date | null; merged_into_id: string | null }[]
  >`
    SELECT id, email, erased_at, merged_into_id FROM customers
    WHERE store_id = ${storeId} AND id = ANY(${[...ids]}::text[])
    ORDER BY id FOR UPDATE`
  if (customers.length !== ids.length) return { same: false }
  const erased = customers.filter(customer => customer.erased_at !== null).map(c => c.id)
  const open = customers.filter(customer => customer.erased_at === null)
  const same = open.every(
    customer =>
      customer.merged_into_id === null &&
      customer.email !== null &&
      dsrEmailHash(normalizeDsrEmail(customer.email), hashKey) === emailHash
  )
  return same ? { same: true, pending: open.map(c => c.id), erased } : { same: false }
}
