import {
  lockStoreForWrite,
  type PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { LONE_SURROGATE } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

// Postgres LIKE treats _ and % as wildcards, and Prisma's `contains` does not escape them: a search
// for "a_c" would match "abc". The backslash is the escape character of LIKE.
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, match => `\\${match}`)
}

// Both of these are the first statements of every write of a customer, in this order: the shared
// lock on the store (so that deleting the store waits), then the customer row (so that two writes
// of the same customer, a merge and an edit for example, take turns). A customer that was absorbed
// by a merge is not found: from then on it is only a snapshot waiting for its 30 days.
export async function lockCustomerForWrite(
  tx: PrismaTransaction,
  storeId: string,
  customerId: string
): Promise<void> {
  await lockStoreForWrite(tx, storeId)
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM customers
    WHERE id = ${customerId} AND store_id = ${storeId} AND merged_into_id IS NULL
    FOR UPDATE`
  if (rows.length === 0) throw resourceNotFound('customer')
}

// What the services of the module run their reads on: the transaction of the request when there is
// one, the client otherwise
export type Db = PrismaService['client']

// Text that a channel sends, made storable: Postgres text cannot hold a NUL character, and the
// engine of Prisma rejects half of an emoji, which cutting by UTF-16 units can leave. It is cut by
// characters, and an empty result is no value.
export function cleanText(raw: string | undefined, maxLength: number): string | undefined {
  if (raw === undefined) return undefined
  const text = Array.from(raw.replaceAll('\0', '').replace(LONE_SURROGATE, '').trim())
    .slice(0, maxLength)
    .join('')
    .trim()
  return text === '' ? undefined : text
}
