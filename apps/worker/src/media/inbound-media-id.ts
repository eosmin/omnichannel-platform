import { createHash } from 'node:crypto'

import type { OriginMediaSlot } from '@platform/core/domain'

const VARIANTS = ['8', '9', 'a', 'b'] as const

// Shaped as a version 5 uuid
function uuidOf(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')
  const variant = VARIANTS[Number.parseInt(hex.charAt(16), 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// The id of the media a message carries at a place: the same message and place always give the same
// id, so a retry of the job finds its row instead of making a second file.
export const inboundMediaId = (messageId: string, index: number): string =>
  uuidOf(`inbound-media:${messageId}:${index}`)

// The same for the picture of an ad: one origin and slot, one media
export const originMediaId = (originId: string, slot: OriginMediaSlot): string =>
  uuidOf(`origin-media:${originId}:${slot}`)
