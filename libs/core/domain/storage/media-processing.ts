import { z } from 'zod'

import { ImageVariants } from './storage-keys'

// What the worker makes of a clean image (TDD_07 §6.5). Every variant is re-encoded to WebP, so what
// is served inline is never the bytes the uploader sent.
export const ImageVariantSpecs = {
  [ImageVariants.FULL]: { width: 2000, height: 2000, fit: 'inside', quality: 85 },
  [ImageVariants.MEDIUM]: { width: 800, height: null, fit: 'inside', quality: 80 },
  [ImageVariants.THUMB]: { width: 160, height: 160, fit: 'cover', quality: 70 }
} as const

export const VARIANT_CONTENT_TYPE = 'image/webp'

// A decoded image can be far bigger than its file (a decompression bomb): the decoder refuses what
// has more pixels than this, whatever the byte size of the file.
export const MAX_IMAGE_PIXELS = 100_000_000

// The part of the scan that does not depend on the machine it runs on
export const VirusScan = {
  // clamd reads a stream in chunks of at most this size (INSTREAM)
  CHUNK_BYTES: 64 * 1024,
  // A scan that takes longer than this is a failed attempt, retried by the queue
  TIMEOUT_MS: 60_000
} as const

// Media.variants: KEYS, never URLs. It comes out of a JSON column, so it is parsed at the boundary.
// A value that is not a key is no variant, and does not take the others down with it.
const variantKey = z.string().min(1).optional().catch(undefined)
export const mediaVariantsSchema = z.object({
  [ImageVariants.FULL]: variantKey,
  [ImageVariants.MEDIUM]: variantKey,
  [ImageVariants.THUMB]: variantKey
})
export type MediaVariants = z.infer<typeof mediaVariantsSchema>

// What `GET /media/:id` answers: short-lived signed URLs on the bucket host
export interface MediaUrls {
  url: string
  filename: string
  contentType: string
  variants: Record<(typeof ImageVariants)[keyof typeof ImageVariants], string | null>
}

// The header of a download. The name is the client's, so it is quoted and encoded (RFC 6266 and
// 5987): a quote, a line break or a non-ASCII character in it cannot end the value or start another.
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
