import { z } from 'zod'

import { MAILPIT_URL } from './env'

const TIMEOUT_MS = 20_000
const POLL_MS = 250
const REQUEST_TIMEOUT_MS = 5_000

const searchSchema = z.object({ messages: z.array(z.object({ ID: z.string() })) })
const messageSchema = z.object({ Text: z.string() })

const searchUrl = (to: string): string =>
  `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`

// A mailbox that holds nothing, so that the next email is the one the test provokes
export async function emptyMailboxOf(to: string): Promise<void> {
  const response = await fetch(searchUrl(to), {
    method: 'DELETE',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  // An email left behind would be read as the next one, with a token that is already spent
  if (!response.ok)
    throw new Error(`Mailpit refused to empty the mailbox of ${to}: ${response.status}`)
}

// The text of the next email that reaches the address. Throws if none comes: the worker sends it
// through the queue, so a few seconds are normal.
export async function nextEmailTo(to: string): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const found = searchSchema.parse(
      await (await fetch(searchUrl(to), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).json()
    )
    const first = found.messages[0]
    if (first !== undefined) {
      const message = await fetch(`${MAILPIT_URL}/api/v1/message/${first.ID}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      return messageSchema.parse(await message.json()).Text
    }
    if (Date.now() > deadline) throw new Error(`no email for ${to} in Mailpit after 20 seconds`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

function captured(text: string, pattern: RegExp, what: string): string {
  const value = pattern.exec(text)?.[1]
  if (value === undefined) throw new Error(`the email holds no ${what}:\n${text}`)
  return value
}

// The token sits in the fragment of the link (/login/verify#token=...), which no server sees
export const magicLinkTokenIn = (text: string): string =>
  captured(text, /#token=([A-Za-z0-9_-]+)/, 'magic link')

export const invitationTokenIn = (text: string): string =>
  captured(text, /\/invitations\/([A-Za-z0-9_-]+)/, 'invitation link')
