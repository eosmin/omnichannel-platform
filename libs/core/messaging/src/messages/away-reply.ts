import { z } from 'zod'

// The `metadata` of the reply a store sends by itself to a customer who writes while it is closed. It
// is how the thread tells that this reply was sent already: the worker looks for it, so the key and
// the value are written in one place.
export const AWAY_REPLY_KEY = 'autoReply'
export const AWAY_REPLY_VALUE = 'away'

export const awayReplyMetadataSchema = z.object({ [AWAY_REPLY_KEY]: z.literal(AWAY_REPLY_VALUE) })

export const AWAY_REPLY_METADATA: Record<typeof AWAY_REPLY_KEY, typeof AWAY_REPLY_VALUE> = {
  [AWAY_REPLY_KEY]: AWAY_REPLY_VALUE
}
