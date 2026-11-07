import { z } from 'zod'

import type { ConversationWhereInput } from '@platform/core/database'

// The position of a page in the list: the (attentionAt, lastMessageAt, id) of the last row it returned,
// the order the list has (a mark of attention first, then the last message, nulls last). A date is
// null for a row without a mark, or without a message yet. Opaque to clients.
export interface ConversationCursor {
  attentionAt: Date | null
  lastMessageAt: Date | null
  id: string
}

export function encodeConversationCursor(row: ConversationCursor): string {
  return Buffer.from(
    JSON.stringify([
      row.attentionAt?.toISOString() ?? null,
      row.lastMessageAt?.toISOString() ?? null,
      row.id
    ])
  ).toString('base64url')
}

const cursorParts = z.tuple([z.iso.datetime().nullable(), z.iso.datetime().nullable(), z.uuid()])
// The cursor of before the mark of attention: (lastMessageAt, id), a row without a mark. A client that
// holds one across the deploy goes on from where it was.
const legacyCursorParts = z.tuple([z.iso.datetime().nullable(), z.uuid()])

// A cursor is about 130 characters; the cap keeps the decoding from running on whatever arrives
const MAX_CURSOR_LENGTH = 256

const dateOrNull = (text: string | null): Date | null => (text === null ? null : new Date(text))

export const conversationCursorSchema = z
  .string()
  .max(MAX_CURSOR_LENGTH)
  .transform((text, ctx): ConversationCursor => {
    try {
      const json: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
      const parts = cursorParts.safeParse(json)
      if (parts.success) {
        const [attentionAt, lastMessageAt, id] = parts.data
        return {
          attentionAt: dateOrNull(attentionAt),
          lastMessageAt: dateOrNull(lastMessageAt),
          id
        }
      }
      const legacy = legacyCursorParts.safeParse(json)
      if (legacy.success) {
        const [lastMessageAt, id] = legacy.data
        return { attentionAt: null, lastMessageAt: dateOrNull(lastMessageAt), id }
      }
    } catch {
      // Not JSON: the issue below says so
    }
    ctx.addIssue({ code: 'custom', message: 'not a cursor of this api' })
    return z.NEVER
  })

// After the row of the cursor in (attentionAt desc, lastMessageAt desc, id desc), nulls last in both
export function afterConversationCursor(cursor: ConversationCursor): ConversationWhereInput {
  const afterMessage =
    cursor.lastMessageAt === null
      ? { lastMessageAt: null, id: { lt: cursor.id } }
      : {
          OR: [
            { lastMessageAt: { lt: cursor.lastMessageAt } },
            { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
            { lastMessageAt: null }
          ]
        }
  return cursor.attentionAt === null
    ? { attentionAt: null, ...afterMessage }
    : {
        OR: [
          { attentionAt: { lt: cursor.attentionAt } },
          { attentionAt: cursor.attentionAt, ...afterMessage },
          { attentionAt: null }
        ]
      }
}
