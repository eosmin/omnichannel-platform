import type { MessageWhereInput } from '@platform/core/database'
import type { AuthorType } from '@platform/core/domain'

// What an inbound reaction or quote points at, when no stored message has that id: the SHAPE of
// the id and of the thread around it, never a value, so the owner can tell why it did not match (another format,
// a truncated id, a message that never arrived) without an id of a customer reaching a log.

export interface MissingTargetShape {
  length: number
  // The first three characters when they are plain (the provider's own marker: `wam`, `m_`), else `?`
  prefix: string
  // Messages in the scope searched (the thread for a quote, the customer on the connection for a reaction) whose
  // id starts with those three, and with the first ten, characters. Prisma does not escape the wildcards of a LIKE
  // for `startsWith`, so `escapeLike` below does: `m_` would otherwise match `mX`.
  sameShortPrefix: number
  sameLongPrefix: number
  // Messages of the customer in that scope in the last two minutes (a quote counts itself: the shape is read once it is stored)
  recentCustomerMessages: number
}

// How many messages of the thread match; the caller scopes it to the store and the thread
export type TargetCount = (filter: { startsWith?: string; since?: Date }) => Promise<number>

const PLAIN_PREFIX = /^[A-Za-z0-9_.-]{3}$/
const SHORT = 3
const LONG = 10
const LOOK_BACK_MS = 2 * 60 * 1000

export async function missingTargetShape(input: {
  targetId: string
  count: TargetCount
  now: Date
}): Promise<MissingTargetShape> {
  const { targetId, count, now } = input
  const short = targetId.slice(0, SHORT)
  const plain = PLAIN_PREFIX.test(short)
  const long = targetId.slice(0, LONG)
  // Counted whatever the characters are (only the log of the prefix is limited to plain ones)
  // One after another: the caller's client is one connection, and nothing here runs inside a transaction
  const sameShortPrefix = await count({ startsWith: short })
  const sameLongPrefix = await count({ startsWith: long })
  const recentCustomerMessages = await count({ since: new Date(now.getTime() - LOOK_BACK_MS) })
  return {
    length: targetId.length,
    prefix: plain ? short : '?',
    sameShortPrefix,
    sameLongPrefix,
    recentCustomerMessages
  }
}

// The diagnostic must never be what fails an ingestion: a count that throws is no shape. It is asked AFTER the
// transaction of the ingestion has ended: inside it, a failed statement would abort the whole transaction.
export async function missingTargetShapeOrNull(
  input: Parameters<typeof missingTargetShape>[0]
): Promise<MissingTargetShape | null> {
  try {
    return await missingTargetShape(input)
  } catch {
    return null
  }
}

// Prisma hands `startsWith` to a LIKE as it is, so the `_` of `m_` would match any character and a `%` anything:
// the wildcards are escaped with the backslash that PostgreSQL takes by default
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&')

// The counter of a thread, for both callers: scoped by the `where` they give (store and thread), the prefix and
// the look-back being the same everywhere
export function countersOf(
  client: { message: { count: (args: { where: MessageWhereInput }) => Promise<number> } },
  scope: MessageWhereInput & { storeId: string },
  customerAuthor: typeof AuthorType.CUSTOMER
): TargetCount {
  return filter =>
    client.message.count({
      where: {
        ...scope,
        ...(filter.startsWith === undefined
          ? {}
          : { channelMessageId: { startsWith: escapeLike(filter.startsWith) } }),
        ...(filter.since === undefined
          ? {}
          : { authorType: customerAuthor, createdAt: { gte: filter.since } })
      }
    })
}
