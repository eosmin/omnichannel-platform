import { z } from 'zod'

import { MAILPIT_API_URL } from './test-env'

const POLL_INTERVAL_MS = 200

const searchSchema = z.object({
  messages: z.array(z.object({ ID: z.string(), Subject: z.string() }))
})
const messageSchema = z.object({
  Subject: z.string(),
  From: z.object({ Address: z.string() }),
  HTML: z.string(),
  Text: z.string()
})
export type MailpitMessage = z.infer<typeof messageSchema>

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${MAILPIT_API_URL}${path}`)
  if (!response.ok) throw new Error(`mailpit ${path} answered ${response.status}`)
  return response.json()
}

export async function messagesTo(address: string): Promise<MailpitMessage[]> {
  const found = searchSchema.parse(
    await getJson(`/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
  )
  return Promise.all(
    found.messages.map(async ({ ID }) =>
      messageSchema.parse(await getJson(`/api/v1/message/${ID}`))
    )
  )
}

// Waits until Mailpit holds at least `count` messages for the address
export async function waitForMessages(
  address: string,
  count = 1,
  timeoutMs = 15_000
): Promise<MailpitMessage[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const messages = await messagesTo(address)
    if (messages.length >= count) return messages
    if (Date.now() > deadline) {
      throw new Error(`${address} has ${messages.length} of ${count} messages in Mailpit`)
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export async function deleteMessagesTo(address: string): Promise<void> {
  await fetch(`${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`, {
    method: 'DELETE'
  })
}
