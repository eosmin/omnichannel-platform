import { createHash } from 'node:crypto'

const VARIANTS = ['8', '9', 'a', 'b'] as const

// The id of the media a message carries at a place: the same message and place always give the same
// id, so a retry of the job finds its row instead of making a second file. Shaped as a version 5 uuid.
export function inboundMediaId(messageId: string, index: number): string {
  const hex = createHash('sha256').update(`inbound-media:${messageId}:${index}`).digest('hex')
  const variant = VARIANTS[Number.parseInt(hex.charAt(16), 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
