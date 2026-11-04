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

// A sticker or a gif moves; the encoder keeps that only when every frame is decoded in memory at once,
// so it is bounded before any frame is decoded: by the number of frames and by the pixels of all of
// them together. At 4 bytes a pixel, the decoded frames, the resized copy and the encoder's own state
// make the peak of one job about 12 bytes a pixel of the budget, and the heavy queue runs two jobs at
// once: 16 million pixels is under 400 MB for both (a 512 px sticker keeps its animation up to 60
// frames). An animation over either cap is drawn still, from its first frame; the original stays and
// downloads as it came.
export const AnimatedImage = {
  CONTENT_TYPES: ['image/gif', 'image/webp'],
  // The names the decoder gives the formats of CONTENT_TYPES
  FORMATS: ['gif', 'webp'],
  MAX_FRAMES: 100,
  MAX_TOTAL_PIXELS: 16_000_000
} as const

// What the header of an image says about its frames, read without decoding them
export interface FrameInfo {
  // The format the decoder found in the bytes, whatever the row says
  format?: string | undefined
  pages?: number | undefined
  width?: number | undefined
  height?: number | undefined
  // The EXIF orientation (1 to 8)
  orientation?: number | undefined
}

const isWhole = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0

// Whether the variants of an image keep its animation. The header is the file's own word: a missing
// or odd size or count is not trusted, and the image is drawn still. So is one whose bytes are not
// what the row says (the caps below are those of a gif or a webp), and one that carries an EXIF
// orientation: the decoder cannot rotate the frames of an animation by a quarter turn.
export function keepsAnimation(contentType: string, info: FrameInfo): boolean {
  if (!(AnimatedImage.CONTENT_TYPES as readonly string[]).includes(contentType)) return false
  const { format, pages, width, height, orientation } = info
  if (format === undefined || !(AnimatedImage.FORMATS as readonly string[]).includes(format)) {
    return false
  }
  if (orientation !== undefined && orientation !== 1) return false
  if (!isWhole(pages) || !isWhole(width) || !isWhole(height)) return false
  if (pages < 2 || pages > AnimatedImage.MAX_FRAMES) return false
  return width * height * pages <= AnimatedImage.MAX_TOTAL_PIXELS
}

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
  // False while the worker still makes the variants of a picture. A picture that is processed and has
  // none is one the decoder refused (a download); one that is not processed yet is still to come.
  processed: boolean
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
