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

// What the sanitizing of an uploaded picture does (TDD_07 §6.5). A photo from a phone carries where it
// was taken, the camera and the time: a static JPEG, PNG or WebP is decoded, turned upright and
// encoded again without any of it, before it is scanned or served. The original bytes are not kept.
export const ImageSanitizing = {
  // The qualities of the new encoding, tried in order until the file fits UploadLimits: high first,
  // because this is the file that goes to the customer
  QUALITIES: [92, 80, 70],
  // The pixels a picture may have to be cleaned. Under the 100 million of the variants: the picture is
  // decoded whole, unscanned, and the worker runs jobs side by side (50 million is a 48 MP camera)
  MAX_INPUT_PIXELS: 50_000_000,
  // The types that are re-encoded. A gif or an animated webp or png is left as it came (see the plan,
  // Step 7.1): the encoder would flatten it, and #181 keeps stickers moving.
  CONTENT_TYPES: ['image/jpeg', 'image/png', 'image/webp']
} as const

// Media.scanResult.reason of a file that was refused before the scan because it cannot be decoded and
// so cannot be cleaned of its metadata: it is never stored, never served
export const MediaRejectionReasons = {
  IMAGE_NOT_SANITIZABLE: 'image_not_sanitizable',
  // A PDF kept as financial evidence that carries something that runs when it is opened (TAX-436)
  PDF_ACTIVE_CONTENT: 'pdf_active_content',
  // A PDF of that kind that cannot be read to the end, so nothing can be said about what it carries: refused as well
  PDF_NOT_INSPECTABLE: 'pdf_not_inspectable'
} as const

// What is looked for in a PDF that stays as the evidence of a transaction (TDD_18 §3): the names of the
// dictionaries that make a reader run code, open a program, send a form somewhere or carry another file. The
// file is read with the PDF library the worker already uses (objects, object streams and escapes in names are
// resolved by a parser, not by a pattern over the bytes) and every name of every object is looked at; the data
// of the streams (pictures, fonts, page content) is not. The rule of the whole check is fail closed: whatever
// cannot be proven inert or cannot be read to the end (an encrypted file, a file the library does not read, a
// stream that looks like an object stream without saying so, a reference to nothing, too much work for one
// file) is refused, never let through. It is a best effort and not a sandbox: the file is only ever served as a
// download from the bucket host (see the plan, Step 4B.4b-1).
export const PdfInspection = {
  CONTENT_TYPE: 'application/pdf',
  ACTIVE_NAMES: [
    'JavaScript',
    'JS',
    'AA',
    'Launch',
    'EmbeddedFile',
    'EF',
    'EmbeddedFiles',
    'FileAttachment',
    'SubmitForm',
    'ResetForm',
    'ImportData',
    'GoToR',
    'GoToE',
    'GoToDp',
    'GoTo3DView',
    'Named',
    'Hide',
    'SetOCGState',
    'Thread',
    'Screen',
    'RichMedia',
    'RichMediaContent',
    'RichMediaActivation',
    'XFA',
    'AcroForm',
    'Rendition',
    'Movie',
    'Sound',
    '3D'
  ],
  // `/OpenAction` is active only when its value is an action, never when it is a destination (`[3 0 R /Fit]`, what
  // Word, LaTeX and Acrobat write): an action that opens a link counts too, which a plain link annotation does not
  CARRIER_NAMES: ['OpenAction'],
  CARRIER_ACTIVE_NAMES: ['URI'],
  CARRIER_DEPTH: 6,
  OBJECT_STREAM_KEYS: { TYPE: 'Type', NAME: 'ObjStm', COUNT: 'N', FIRST: 'First' },
  // The work on one file is bounded in objects, nodes and time
  MAX_OBJECTS: 300_000,
  MAX_NODES: 3_000_000,
  TIME_BUDGET_MS: 5000,
  UNREADABLE: {
    ENCRYPTED: 'encrypted',
    NOT_READABLE: 'not_readable',
    UNDECLARED_OBJECT_STREAM: 'undeclared_object_stream',
    DANGLING_REFERENCE: 'dangling_reference',
    TOO_MANY_OBJECTS: 'too_many_objects',
    TIME_BUDGET_EXCEEDED: 'time_budget_exceeded',
    INSPECTION_FAILED: 'inspection_failed'
  }
} as const
