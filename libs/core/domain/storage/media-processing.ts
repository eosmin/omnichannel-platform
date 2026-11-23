import { z } from 'zod'

import { ImageVariants } from './storage-keys'
import { UploadLimits } from './upload-constants'

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
  // What the sweep answers for a document it did not finish and did not mark: the object or the row changed under it (never written to a row)
  CHANGED: 'changed',
  Outcomes: {
    ALREADY_CLEAN: ExistingPictureSweep.Outcomes.ALREADY_CLEAN,
    // Kept as it came: encrypted, signed, damaged or too big once opened (the reason is in the log of `sanitizeDocument`)
    NOT_CLEANABLE: ExistingPictureSweep.Outcomes.NOT_CLEANABLE,
    FAILED: ExistingPictureSweep.Outcomes.FAILED,
    MISSING: ExistingPictureSweep.Outcomes.MISSING,
    // The row names a file outside the folder of its store: never read, written or deleted by the sweep, left as it is and logged
    FOREIGN_KEY: 'foreign_key'
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
  // How a document the cleaner wrote begins: a PDF, and the zip of a docx or an xlsx (the parent checks what comes back from the thread)
  PDF_MAGIC: '%PDF-',
  ZIP_MAGIC: [0x50, 0x4b, 0x03, 0x04],
  // ... and how it ends: the PDF trailer mark in the last KiB, the end-of-central-directory record of the zip in the last 64 KiB + 22 bytes
  PDF_END_MARK: '%%EOF',
  PDF_END_WINDOW_BYTES: 1024,
  ZIP_END_MAGIC: [0x50, 0x4b, 0x05, 0x06],
  ZIP_END_WINDOW_BYTES: 65_557,
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
  // The document thread (Step 7.3): a document is parsed on a worker thread that is killed when it passes the deadline or the memory limit.
  // The deadline is per document and counts from the start of the thread; a real document of 10 MB takes well under a second
  THREAD_TIMEOUT_MS: 30_000,
  THREAD_MAX_OLD_GENERATION_MB: 384,
  THREAD_MAX_YOUNG_GENERATION_MB: 32,
  THREAD_STACK_MB: 4,
  // How long the stop of a thread is waited for (a thread inside a synchronous native call cannot be interrupted until it returns)
  THREAD_STOP_TIMEOUT_MS: 5000,
  // The file of the thread, next to `main.js` in the bundle of the worker (a second entry of its rspack configuration)
  THREAD_ENTRY_FILE: 'document-thread.js',
  // The error code Node gives a thread that passed its memory limit
  THREAD_OUT_OF_MEMORY_CODE: 'ERR_WORKER_OUT_OF_MEMORY',
  // What the thread answers (`document-cleaner.ts`): the bytes it made, why it left the document, or an error of the machine
  ThreadReplies: {
    SANITIZED: 'sanitized',
    UNTOUCHED: 'untouched',
    ENVIRONMENT: 'environment'
  },
  // Why a document was left as it came
  Untouched: {
    TYPE: 'type',
    ALREADY_CLEAN: 'already_clean',
    NOT_CLEANABLE: 'not_cleanable',
    TIMED_OUT: 'timed_out'
  },
  CORE_PROPERTIES_PATH: 'docProps/core.xml',
  // The end of the type of the relationship that names each part (the whole type is a URL of the Open Packaging Conventions)
  CORE_RELATIONSHIP_SUFFIX: '/core-properties',
  THUMBNAIL_RELATIONSHIP_SUFFIX: '/thumbnail',
  APP_PROPERTIES_PATH: 'docProps/app.xml',
  CUSTOM_PROPERTIES_PATH: 'docProps/custom.xml',
  // The version of the cleaning of a document (Step 7.3, `office-user-paths-and-embedded-media`). Version 1 cleaned the properties; version 2
  // also anonymizes the paths of the author's machine and cleans the metadata of the photos inside the document. A row that was cleaned
  // with an older version carries the mark without this key, and the sweep of stored documents takes it again; the mark of a document
  // cleaned now carries it. Raise it when the cleaning learns something new that an old row may still hold.
  CLEANING_VERSION: 2,
  CLEANING_VERSION_KEY: 'cleaningVersion',
  // The part of an xlsx that records where the file was last saved (`x15ac:absPath`), and the parts of a package that hold the photos
  WORKBOOK_PATH: 'xl/workbook.xml',
  ABSOLUTE_PATH_ELEMENT: 'absPath',
  ABSOLUTE_PATH_ATTRIBUTE: 'url',
  EMBEDDED_IMAGE_DIRECTORIES: ['word/media/', 'xl/media/'],
  // What replaces the path of the author's machine: a local target that points nowhere and names nobody. The relationship stays (the
  // document refers to it by id), only where it points changes
  NEUTRAL_LOCAL_TARGET: 'file:///local-file',
  NEUTRAL_LOCAL_PATH: 'C:\\local-file\\',
  // The longest tag of a package read for a path, and how far back from the name of an element its `<` is looked for
  MAX_PATH_TAG_BYTES: 8192,
  MAX_ELEMENT_PREFIX_BYTES: 40,
  // How long the photos of one document are cleaned: a document of many photos keeps the rest as it came (and the properties are cleaned
  // anyway) rather than pass the deadline of its thread and keep everything
  EMBEDDED_IMAGES_BUDGET_MS: 12_000,
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

// The metadata of video and audio (Step 7.1-J-1). A phone puts where the clip was taken (`©xyz`, ISO 6709), the model and the time in the container,
// and a player or a download shows it. The cleaner copies the streams into a new container with no metadata (`ffmpeg -c copy`, nothing is
// decoded or re-encoded, so the picture and the sound are the same bytes) in a process of its own, because it reads the file of a stranger.
// Every argument below is a constant: nothing that comes from the file or its name is ever put on a command line.
export const AvSanitizing = {
  // The tools the worker image carries (the `ffmpeg-build` stage of `docker/node-service.Dockerfile`, LGPL, demuxers and muxers only)
  FFMPEG_PATH: '/opt/ffmpeg/bin/ffmpeg',
  FFPROBE_PATH: '/opt/ffmpeg/bin/ffprobe',
  // Limits the child gets from the kernel (util-linux `prlimit`, run by the same fixed command line): address space, CPU seconds, the size of
  // a file it writes and the files it holds open. A copy of 10 MB needs a few MB of each; these only stop a file that makes it run away
  PRLIMIT_PATH: '/usr/bin/prlimit',
  LIMIT_ADDRESS_SPACE_BYTES: 1024 * 1024 * 1024,
  LIMIT_CPU_SECONDS: 20,
  LIMIT_FILE_BYTES: UploadLimits.MAX_FILE_SIZE_BYTES * 2,
  LIMIT_OPEN_FILES: 64,
  // The deadline of each child (ffprobe, ffmpeg, ffprobe again), counted from its start; then it and its whole process group are killed
  TOOL_TIMEOUT_MS: 20_000,
  // What ffprobe may print before the file is given up as hostile (a real clip prints a few KB)
  MAX_PROBE_OUTPUT_BYTES: 512 * 1024,
  // The names inside the private directory of one clean (cwd of the child): fixed, so the command lines never hold a path
  INPUT_FILE: 'input.bin',
  OUTPUT_FILE: 'output.bin',
  TEMP_DIR_PREFIX: 'av-clean-',
  // The length of the clip may move by this much between the original and the copy (a container may round the end of a stream)
  DURATION_TOLERANCE_SECONDS: 0.25,
  DURATION_TOLERANCE_RATIO: 0.01,
  // The tags a file may show and still be called clean, each with the only values it may have: the ones a muxer writes by itself. Any other value
  // (a handler named after a person, a brand with a place in it) is metadata, in the file as it came and in the copy. Keys in lowercase
  ALLOWED_TAGS: {
    major_brand: '^[ -~]{4}$',
    minor_version: '^[0-9]{1,10}$',
    compatible_brands: '^[A-Za-z0-9 ]{0,64}$',
    handler_name: '^(VideoHandler|SoundHandler)$',
    vendor_id: '^(FFMP|\\[0\\]\\[0\\]\\[0\\]\\[0\\])$',
    language: '^und$'
  } as Readonly<Record<string, string>>,
  // Names in the bytes of a file that mean where or with what it was shot. The cleaned file must hold none of them. Only long names: a four-byte
  // name such as `\u00a9xyz` shows up by chance in 10 MB of audio now and then, and a false alarm would leave the original, with its GPS, in place;
  // the atoms of a mov or mp4 are read as tags by ffprobe, which is the check for the short ones
  FORBIDDEN_BYTE_PATTERNS: ['ISO6709', 'com.apple.quicktime.', 'creation_time'],
  // An ID3 tag at the start of an mp3 or an aac (its position is the first bytes, so it is checked there and not as a pattern); the header is 10
  // bytes, the last four its size
  ID3_MAGIC: 'ID3',
  ID3_HEADER_BYTES: 10,
  // Why a file was left as it came (it is never lost and never refused: the caller logs the id and keeps the original)
  Untouched: {
    TYPE: 'type',
    TOO_LARGE: 'too_large',
    NOT_CLEANABLE: 'not_cleanable',
    TIMED_OUT: 'timed_out'
  },
  Results: { CLEANED: 'cleaned', UNTOUCHED: 'untouched' },
  // The marks of the scan in `Media.scanResult` (Step 7.1-J-2), as the pictures and documents have theirs: the version of the cleaning that
  // looked at the file, so that a retry of the scan and the sweep (J-3) do not copy it again, and a newer version takes it again.
  // `OUTCOME_KEY` is written when the file was kept as it came: the value is `Untouched.*` (the file's own fault: damaged, too big, a
  // deadline) or `Outcomes.AV_UNAVAILABLE` (an INBOUND file whose every attempt hit an error of the machine: the sweep of stored files, J-3,
  // takes it again when the tools are back). Nothing is refused and nothing is lost
  CLEANING_VERSION: 1,
  CLEANING_VERSION_KEY: 'cleaningVersion',
  OUTCOME_KEY: 'avCleaning',
  // The label `result` of `MetricNames.AV_CLEANING` (closed set: no id, no name, no content)
  Outcomes: {
    CLEANED: 'cleaned',
    NOT_CLEANABLE: 'not_cleanable',
    AV_UNAVAILABLE: 'av_unavailable'
  },
  // Why a copy was not taken (`verifyCleaned`); the reason is logged by the caller as a code, never with a piece of the file
  Refusals: {
    EMPTY: 'empty',
    NO_MEDIA_STREAM: 'no_media_stream',
    COVER_KEPT: 'cover_kept',
    DATA_KEPT: 'data_kept',
    STREAMS_CHANGED: 'streams_changed',
    DURATION_UNKNOWN: 'duration_unknown',
    DURATION_CHANGED: 'duration_changed',
    TAGS_KEPT: 'tags_kept',
    SOURCE_NAMED: 'source_named'
  },
  // How each type is read and written: the demuxer and muxer are named, never probed, so a file cannot pass for another format. `args` come
  // after the maps. Audio drops the video streams (`-vn`): in an audio file they are the cover, a picture that carries its own EXIF
  FORMATS: {
    'video/mp4': { input: 'mov', output: 'mp4', args: [] },
    'video/quicktime': { input: 'mov', output: 'mov', args: [] },
    'audio/mp4': { input: 'mov', output: 'mp4', args: ['-vn'] },
    'audio/mpeg': {
      input: 'mp3',
      output: 'mp3',
      args: ['-vn', '-write_id3v2', '0']
    },
    'audio/ogg': { input: 'ogg', output: 'ogg', args: ['-vn'] },
    'audio/wav': { input: 'wav', output: 'wav', args: ['-vn'] },
    'audio/aac': { input: 'aac', output: 'adts', args: ['-vn'] }
  } as Readonly<Record<string, { input: string; output: string; args: readonly string[] }>>
} as const
