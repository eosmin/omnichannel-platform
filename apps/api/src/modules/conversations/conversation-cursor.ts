import { z } from 'zod'

// The position of a page in the list: the (lastMessageAt, id) of the last row it returned. The date
// is null for a conversation that has no message yet, which the list puts last. Opaque to clients.
export interface ConversationCursor {
  lastMessageAt: Date | null
  id: string
}

export function encodeConversationCursor(row: ConversationCursor): string {
  return Buffer.from(JSON.stringify([row.lastMessageAt?.toISOString() ?? null, row.id])).toString(
    'base64url'
  )
}

const cursorParts = z.tuple([z.iso.datetime().nullable(), z.uuid()])

// A cursor is about 90 characters; the cap keeps the decoding from running on whatever arrives
const MAX_CURSOR_LENGTH = 256

export const conversationCursorSchema = z
  .string()
  .max(MAX_CURSOR_LENGTH)
  .transform((text, ctx): ConversationCursor => {
    try {
      const parts = cursorParts.safeParse(
        JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
      )
      if (parts.success) {
        const [date, id] = parts.data
        return { lastMessageAt: date === null ? null : new Date(date), id }
      }
    } catch {
      // Not JSON: the issue below says so
    }
    ctx.addIssue({ code: 'custom', message: 'not a cursor of this api' })
    return z.NEVER
  })
