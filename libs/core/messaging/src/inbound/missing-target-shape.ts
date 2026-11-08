// What an inbound reaction or quote points at, when no stored message has that id: the SHAPE of
// the id and of the thread around it, never a value, so the owner can tell why it did not match (another format,
// a truncated id, a message that never arrived) without an id of a customer reaching a log.

export interface MissingTargetShape {
  length: number
  // The first three characters when they are plain (the provider's own marker: `wam`, `m_`), else `?`
  prefix: string
  // Messages of the thread whose id starts with those three, and with the first ten, characters (Prisma escapes
  // the wildcards of a LIKE, so `_` in `m_` matches only itself)
  sameShortPrefix: number
  sameLongPrefix: number
  // Messages of the customer in the two minutes before
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
  const [sameShortPrefix, sameLongPrefix, recentCustomerMessages] = await Promise.all([
    count({ startsWith: short }),
    count({ startsWith: long }),
    count({ since: new Date(now.getTime() - LOOK_BACK_MS) })
  ])
  return {
    length: targetId.length,
    prefix: plain ? short : '?',
    sameShortPrefix,
    sameLongPrefix,
    recentCustomerMessages
  }
}

// The diagnostic must never be what fails an ingestion: a count that throws is no shape
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
  tx: { message: { count: (args: { where: Record<string, unknown> }) => Promise<number> } },
  scope: Record<string, unknown>,
  customerAuthor: string
): TargetCount {
  return filter =>
    tx.message.count({
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
