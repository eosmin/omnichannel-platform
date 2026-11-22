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
  // The types the cleaner takes. A jpeg, a png or a webp that is a still picture is re-encoded; a gif and an animated webp or png are
  // never re-encoded (the encoder would flatten them, and #181 keeps stickers moving): their metadata blocks are cut out of the
  // container and every other byte stays (`animated-image-cleaner.ts`, Step 7.1)
  CONTENT_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  // The pictures one worker process decodes at the same time, whatever the concurrency of the queues that call the cleaner: a
  // picture of MAX_INPUT_PIXELS is about 200 MB of raster plus the encoder, so the peak of the cleaning is bounded by this number
  // and not by the sum of the queues (Step 7.1, "Memory of the picture cleaning")
  MAX_CONCURRENT_DECODES: 1
} as const

// The sweep that cleans the pictures stored before the cleaning existed (`ExistingPictureSanitizer`, Step 7.1): every run takes a bounded
// batch of each store, the oldest first, and the progress is in the rows themselves, so it is safe to repeat and resumes where it stopped.
export const ExistingPictureSweep = {
  // Rows taken per store per run, and rows in the whole run (a full run is logged and the next one takes the rest)
  BATCH_PER_STORE: 25,
  MAX_PER_RUN: 100,
  // Media.scanResult is written whole by the sweep, and a row it has not finished holds only its own keys (nothing else writes the `scan_result` of a clean picture): `sanitized: true` is the mark the scan writes on a picture it cleaned (an older row has
  // none); a picture the sweep looked at and could not or need not rewrite carries `sanitizeSweep: <outcome>` so it is not taken again
  CLEANED_KEY: 'sanitized',
  OUTCOME_KEY: 'sanitizeSweep',
  // A picture that fails (the bucket, the machine) is tried again on the next runs, `scanResult.sweepAttempts` counting, and after MAX_ATTEMPTS
  // it ends as `failed` so that one bad row cannot hold the batch of its store for ever. Clearing its `scan_result` makes the sweep take it again.
  ATTEMPTS_KEY: 'sweepAttempts',
  MAX_ATTEMPTS: 3,
  // A run stops taking pictures after this long, under the lock of its schedule, so two runs never overlap
  MAX_RUN_MS: 420_000,
  Outcomes: {
    // The file held no metadata (a crash between the write and the mark, or a picture that was already clean): only the mark is written
    ALREADY_CLEAN: 'already_clean',
    // A gif or an animation: left as it came (see the plan, Step 7.1)
    UNTOUCHED: 'untouched',
    // The picture no longer decodes. It was served as clean, so it is never deleted by the sweep: left as it is and logged
    UNDECODABLE: 'undecodable',
    // It decodes but cannot be cleaned (it does not fit the file limit once re-encoded, a size it may not have): left as it is, with its metadata, and logged
    NOT_CLEANABLE: 'not_cleanable',
    // It failed MAX_ATTEMPTS times: left as it is and logged at error level
    FAILED: 'failed',
    // The row names a file that is not in the bucket: logged, left for the cleanup of stray rows
    MISSING: 'missing'
  }
} as const

// The sweep that cleans the documents (PDF, docx, xlsx) stored before their cleaning existed (`ExistingDocumentSanitizer`, Step 7.1): the same
// pattern as the sweep of pictures, with the same marks in the row (`ExistingPictureSweep.CLEANED_KEY`, `OUTCOME_KEY`, `ATTEMPTS_KEY`), but a
// smaller batch, because a document is parsed whole and synchronously (`sanitizeDocument` runs in the decode slot, one at a time per process)
export const ExistingDocumentSweep = {
  BATCH_PER_STORE: 10,
  MAX_PER_RUN: 40,
  MAX_ATTEMPTS: ExistingPictureSweep.MAX_ATTEMPTS,
  // Under the lock of its schedule, as the sweep of pictures
  MAX_RUN_MS: 420_000,
  Outcomes: {
    ALREADY_CLEAN: ExistingPictureSweep.Outcomes.ALREADY_CLEAN,
    // Kept as it came: encrypted, signed, damaged or too big once opened (the reason is in the log of `sanitizeDocument`)
    NOT_CLEANABLE: ExistingPictureSweep.Outcomes.NOT_CLEANABLE,
    FAILED: ExistingPictureSweep.Outcomes.FAILED,
    MISSING: ExistingPictureSweep.Outcomes.MISSING
  }
} as const

// The guard of the sweeps that rewrite a stored file (pictures and documents): in a deployed environment they run only while the bucket
// shows versioning on, the one way back for an original that was rewritten (owner's decision, 2026-11-21; TDD_03 §7.3). The question is asked
// again on every run, and one that is not answered in time counts as off
export const StoredFileSweepGuard = {
  INSPECT_TIMEOUT_MS: 5000
} as const
// The injection token of the guard's switch: true in a deployed environment (set by the storage platform module, the one place that reads the env)
export const SWEEP_NEEDS_VERSIONING = Symbol('SWEEP_NEEDS_VERSIONING')

// Media.scanResult.reason of a file that was refused before the scan because it cannot be decoded and
// so cannot be cleaned of its metadata: it is never stored, never served
export const MediaRejectionReasons = {
  IMAGE_NOT_SANITIZABLE: 'image_not_sanitizable',
  // A PDF kept as financial evidence that carries something that runs when it is opened (TAX-436)
  PDF_ACTIVE_CONTENT: 'pdf_active_content'
} as const

// What is looked for in a PDF that stays as the evidence of a transaction (TDD_18 §3, TAX-436): the names that make
// a reader run code, open a program or send a form somewhere, in the clear. A PDF names them with a slash and may
// spell a letter as `#` and two hex digits, so the match is made on the decoded name. `/OpenAction` and `/AA` are not
// on the list: they carry an action, and the action is what is named (`/S /JavaScript`); a destination
// (`[3 0 R /Fit]`, what Word, LaTeX and Acrobat write) is not refused. BEST EFFORT, NOT A SANDBOX: objects inside
// compressed streams are not inspected (nothing is inflated, nothing is parsed). The defences that matter are that
// the file is only ever served as a signed download from the bucket host (`Content-Disposition: attachment`) and the
// ClamAV scan that runs before this.
export const PdfInspection = {
  CONTENT_TYPE: 'application/pdf',
  ACTIVE_NAMES: ['JavaScript', 'JS', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'RichMedia'],
  // The bytes are read one to one as text, so that a name is never split by a multi-byte character
  TEXT_ENCODING: 'latin1',
  // A name: a slash and the regular characters after it, up to white space (NUL is one) or a delimiter. `/JSON` is the name JSON,
  // never the name JS. The source of a global pattern, so that nobody shares one stateful regular expression
  NAME_PATTERN: '\\/([^\\s\\0/[\\]<>(){}%]+)',
  // A letter spelled as the mark and two hex digits
  HEX_ESCAPE_MARK: '#',
  HEX_ESCAPE_PATTERN: '#([0-9A-Fa-f]{2})',
  HEX_RADIX: 16
} as const

// What is cut out of a gif, an animated WebP and an animated PNG (`animated-image-cleaner.ts`). The frames, the delays and the loop are
// never touched, only the blocks that can carry an author, a program, a comment or a place.
export const AnimatedImageCleaning = {
  // A gif extension that stays: the loop count of the animation and the colour profile (the others, XMP and the program that wrote it, go)
  GIF_KEPT_APPLICATIONS: ['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'],
  GIF_APPLICATION_ID_BYTES: 11,
  // The RIFF chunks of a WebP that hold metadata (the colour profile stays), and the flags of its extended header that announce them
  WEBP_DROPPED_CHUNKS: ['EXIF', 'XMP '],
  WEBP_FLAG_EXIF: 0x08,
  WEBP_FLAG_XMP: 0x04,
  // The PNG chunks that hold text, a program or a date: they are not needed to draw it
  PNG_DROPPED_CHUNKS: ['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']
} as const

// What is cut out of a PDF, a docx and an xlsx on upload (`document-sanitizer.ts`, Step 7.1): the author, the program and the dates of the
// document properties, and the thumbnail. The content, the styles and the comments stay. A document that is financial evidence is kept
// as it came (`isEvidenceMedia`), and one that cannot be cleaned without risk is kept as it came and logged.
export const DocumentSanitizing = {
  PDF_CONTENT_TYPE: 'application/pdf',
  // The key a digital signature of a PDF always has (the byte range it covers): a PDF with it is not rewritten
  PDF_SIGNATURE_MARK: '/ByteRange',
  DOCX_CONTENT_TYPE: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX_CONTENT_TYPE: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // The sum of what a zip may inflate to: a bigger one is not opened (a zip bomb); the document stays as it came
  MAX_UNCOMPRESSED_BYTES: 64 * 1024 * 1024,
  MAX_ZIP_ENTRIES: 5000,
  // The list of relationships of a package (a real one is under 10 KB); past this the document is kept as it came
  MAX_RELATIONSHIPS_BYTES: 64 * 1024,
  // The date the zip entries get, so that the cleaning does not write the day it ran into the file
  ZIP_ENTRY_YEAR: 1980,
  ZIP_LEVEL: 6,
  CORE_PROPERTIES_PATH: 'docProps/core.xml',
  // The end of the type of the relationship that names each part (the whole type is a URL of the Open Packaging Conventions)
  CORE_RELATIONSHIP_SUFFIX: '/core-properties',
  THUMBNAIL_RELATIONSHIP_SUFFIX: '/thumbnail',
  APP_PROPERTIES_PATH: 'docProps/app.xml',
  CUSTOM_PROPERTIES_PATH: 'docProps/custom.xml',
  THUMBNAIL_PATH_PATTERN: '^docProps/thumbnail\\.[a-z]+$',
  RELATIONSHIPS_PATH: '_rels/.rels',
  CORE_PROPERTIES_XML:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>',
  APP_PROPERTIES_XML:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>',
  CUSTOM_PROPERTIES_XML:
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>'
} as const
