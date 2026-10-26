import { z } from 'zod'

// The position of a page in the list: the (createdAt, id) of the last row it returned. It holds
// where to go on and not a row to look for, so a customer deleted or merged meanwhile does not
// break the next page. Opaque to clients.
export interface ListCursor {
  createdAt: Date
  id: string
}

export function encodeCursor(row: ListCursor): string {
  return Buffer.from(JSON.stringify([row.createdAt.toISOString(), row.id])).toString('base64url')
}

const cursorParts = z.tuple([z.iso.datetime(), z.uuid()])

export const cursorSchema = z.string().transform((text, ctx): ListCursor => {
  try {
    const parts = cursorParts.safeParse(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')))
    if (parts.success) return { createdAt: new Date(parts.data[0]), id: parts.data[1] }
  } catch {
    // Not JSON: the issue below says so
  }
  ctx.addIssue({ code: 'custom', message: 'not a cursor of this api' })
  return z.NEVER
})
