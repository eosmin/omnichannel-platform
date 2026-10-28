import type { PrismaTransaction } from '@platform/core/database'
import { safeText } from '@platform/core/domain'

import type { InboundOrigin, JsonValue } from './inbound-event'

function safeJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return safeText(value)
  if (Array.isArray(value)) return value.map(safeJson)
  if (value !== null && typeof value === 'object') return safeObject(value)
  return value
}

const safeObject = (value: Record<string, JsonValue>): Record<string, JsonValue> =>
  Object.fromEntries(Object.entries(value).map(([key, item]) => [safeText(key), safeJson(item)]))

// Nothing left after cleaning is nothing: an id made only of NULs must not stand for an ad
const clean = (text: string | undefined): string | null => {
  const cleaned = text === undefined ? '' : safeText(text)
  return cleaned === '' ? null : cleaned
}

interface Ad {
  sourceId: string | null
  sourceUrl: string | null
}

// Two entries are the same ad when their ids agree, or, if one of them has no id, when their links do.
// A delivery that has the id and the link and another that has only the link are one ad.
function sameAd(a: Ad, b: Ad): boolean {
  if (a.sourceId !== null && b.sourceId !== null) return a.sourceId === b.sourceId
  return a.sourceUrl !== null && a.sourceUrl === b.sourceUrl
}

// The ad a message came from, kept apart from the message so that a thread that several ads reach
// shows the latest one and still knows the first. The same ad in a row is one entry in the thread: a
// customer who writes five times from one ad has one origin, not five. (Whether the message was a
// click is not decided here: the window of the channel counts every referral as one.) The events of
// one customer take turns (the caller holds the lock), so two of them never read the same latest entry.
export async function recordOrigin(
  tx: PrismaTransaction,
  input: {
    storeId: string
    conversationId: string
    messageId: string
    origin: InboundOrigin
    createdAt: Date
  }
): Promise<void> {
  const { storeId, conversationId, messageId, origin } = input
  const ad: Ad = { sourceId: clean(origin.sourceId), sourceUrl: clean(origin.sourceUrl) }
  const latest = await tx.conversationOrigin.findFirst({
    where: { storeId, conversationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { sourceId: true, sourceUrl: true }
  })
  if (latest !== null && sameAd(ad, latest)) return
  await tx.conversationOrigin.create({
    data: {
      storeId,
      conversationId,
      messageId,
      kind: origin.kind,
      ...ad,
      title: clean(origin.title),
      body: clean(origin.body),
      mediaType: origin.media?.type ?? null,
      mediaRef: clean(origin.media?.ref),
      mediaUrl: clean(origin.media?.url),
      thumbnailUrl: clean(origin.thumbnailUrl),
      clickId: clean(origin.clickId),
      ...(origin.referral === undefined ? {} : { referral: safeObject(origin.referral) }),
      createdAt: input.createdAt
    }
  })
}
