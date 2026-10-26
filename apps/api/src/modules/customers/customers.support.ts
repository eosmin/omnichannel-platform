import {
  lockStoreForWrite,
  type PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

export const HTTP_BAD_REQUEST = 400
export const HTTP_FORBIDDEN = 403
export const HTTP_NOT_FOUND = 404
export const HTTP_CONFLICT = 409

export function notFound(what: string): PlatformException {
  return new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, `${what} not found`, HTTP_NOT_FOUND)
}

export function conflict(message: string, details?: Record<string, unknown>): PlatformException {
  return new PlatformException(ErrorCodes.RESOURCE_CONFLICT, message, HTTP_CONFLICT, details)
}

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
  if (rows.length === 0) throw notFound('customer')
}

// What the services of the module run their reads on: the transaction of the request when there is
// one, the client otherwise
export type Db = PrismaService['client']

// Half of an emoji: a high surrogate with no low one after it, or a low one with no high one before
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

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
