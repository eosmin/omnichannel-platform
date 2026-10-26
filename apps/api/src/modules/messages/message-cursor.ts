import { z } from 'zod'

// The position of a page of the thread: the (createdAt, id) of the last message it returned. Opaque
// to clients.
export interface MessageCursor {
  createdAt: Date
  id: string
}

export function encodeMessageCursor(row: MessageCursor): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url')
}

const cursorParts = z.tuple([z.iso.datetime(), z.uuid()])

// A cursor is about 90 characters; the cap keeps the decoding from running on whatever arrives
const MAX_CURSOR_LENGTH = 256

export const messageCursorSchema = z
  .string()
  .max(MAX_CURSOR_LENGTH)
  .transform((text, ctx): MessageCursor => {
    try {
      const parts = cursorParts.safeParse(
        JSON.parse(Buffer.from(text, 'base64url').toString('utf8'))
      )
      if (parts.success) {
        const [date, id] = parts.data
        return { createdAt: new Date(date), id }
      }
    } catch {
      // Not JSON: the issue below says so
    }
    ctx.addIssue({ code: 'custom', message: 'not a cursor of this api' })
    return z.NEVER
  })
