import { crc32 } from 'node:zlib'

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib'

import { DocumentSanitizing, UploadLimits } from '@platform/core/storage'

import { isEnvironmentError, withDecodeSlot } from './image-sanitizer'

// What came of cleaning a document. A document is never refused for failing to clean: it is kept as it came, with its reason, so that the
// caller can log it (the document is the customer's own, and refusing it would lose a real file for a property block).
export type SanitizedDocument =
  | { kind: 'sanitized'; body: Buffer }
  | { kind: 'untouched'; why: 'type' | 'already_clean' | 'not_cleanable' }

export const isSanitizedDocumentType = (contentType: string): boolean =>
  contentType === DocumentSanitizing.PDF_CONTENT_TYPE ||
  contentType === DocumentSanitizing.DOCX_CONTENT_TYPE ||
  contentType === DocumentSanitizing.XLSX_CONTENT_TYPE

// ---- PDF -------------------------------------------------------------------------------------------------------------------------
// The document information (author, program, title, dates) and every XMP stream (the catalog's, a page's, an image's) are removed, and the
// objects are deleted too: pdf-lib keeps every object of the file, also the ones an incremental update left behind that nothing points to,
// so the objects that look like an information dictionary or like XMP are dropped wherever they are. Nothing else is touched.
const INFO_KEYS = [
  'Author',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Title',
  'Subject',
  'Keywords'
]
const METADATA_KEY = PDFName.of('Metadata')
const PIECE_INFO_KEY = PDFName.of('PieceInfo')

const dictOf = (object: unknown): PDFDict | undefined =>
  object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : undefined

// An information dictionary has none of the keys of a page, a font or an image: no `Type`, and one of the keys of the information
const looksLikeInfo = (dict: PDFDict): boolean =>
  !dict.has(PDFName.of('Type')) && INFO_KEYS.some(key => dict.has(PDFName.of(key)))

const isXmp = (dict: PDFDict): boolean =>
  dict.get(PDFName.of('Type')) === PDFName.of('Metadata') &&
  dict.get(PDFName.of('Subtype')) === PDFName.of('XML')

// How many blocks of properties a document holds (the count is the check of the cleaning: zero once it is cleaned)
function propertyBlocks(doc: PDFDocument): number {
  let found = doc.context.trailerInfo.Info === undefined ? 0 : 1
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = dictOf(object)
    if (dict === undefined) continue
    if (looksLikeInfo(dict) || isXmp(dict) || dict.has(METADATA_KEY) || dict.has(PIECE_INFO_KEY)) {
      found += 1
    }
  }
  return found
}

async function cleanPdf(input: Buffer): Promise<Buffer | 'already_clean'> {
  // A signed PDF is valid only for the exact bytes that were signed: rewriting it would break the signature, so it stays as it came
  if (input.includes(DocumentSanitizing.PDF_SIGNATURE_MARK)) {
    throw new Error('the pdf is signed')
  }
  // An encrypted document cannot be rewritten without its key: load refuses it and it stays as it came
  const doc = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: true })
  const { context } = doc
  // pdf-lib reads a file that is not a PDF as an empty document; a document with no page is not one it can vouch for
  if (doc.getPageCount() === 0) throw new Error('the pdf has no page')
  if (propertyBlocks(doc) === 0) return 'already_clean'
  delete context.trailerInfo.Info
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const dict = dictOf(object)
    if (dict === undefined) continue
    if (looksLikeInfo(dict) || isXmp(dict)) {
      context.delete(ref)
      continue
    }
    dict.delete(METADATA_KEY)
    dict.delete(PIECE_INFO_KEY)
  }
  doc.catalog.delete(METADATA_KEY)
  const saved = await doc.save({ useObjectStreams: false })
  // Read back: it must load again with the same pages and carry no block of properties
  const again = await PDFDocument.load(saved, { updateMetadata: false, throwOnInvalidObject: true })
  if (propertyBlocks(again) !== 0 || again.getPageCount() !== doc.getPageCount()) {
    throw new Error('the cleaned pdf is not what it should be')
  }
  return Buffer.from(saved)
}

// ---- docx and xlsx ---------------------------------------------------------------------------------------------------------------
// The package is a zip: the property parts are written again empty (the author, the last editor, the dates, the company, the program), the
// thumbnail is removed with the relationship that points to it, and the zip is written again with a fixed entry date. The core properties
// are the part that the package relationships name (Word and Excel use `docProps/core.xml`, other writers use another path). The text, the
// styles, the sheets and the comments are the same bytes.
const RELATIONSHIP = /<Relationship\b[^>]*?(?:\/>|>\s*<\/Relationship\s*>)/g

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return match?.[1] ?? match?.[2]
}

const packagePath = (target: string): string => target.replace(/^\/+/, '')

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50
const EOCD_MIN_BYTES = 22
const CENTRAL_ENTRY_BYTES = 46
const ZIP64_MARK = 0xffffffff

// The CRC-32 of each part as the central directory of the zip declares it (a zip64 package is not read: it throws, and the document is kept)
function centralDirectoryCrcs(input: Buffer): Map<string, number> {
  let eocd = -1
  for (let at = input.length - EOCD_MIN_BYTES; at >= Math.max(0, input.length - 65_557); at -= 1) {
    if (input.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('the zip has no end record')
  const count = input.readUInt16LE(eocd + 10)
  let at = input.readUInt32LE(eocd + 16)
  if (at === ZIP64_MARK || count === 0xffff) throw new Error('a zip64 package is not read')
  const crcs = new Map<string, number>()
  for (let n = 0; n < count; n += 1) {
    if (
      at + CENTRAL_ENTRY_BYTES > input.length ||
      input.readUInt32LE(at) !== CENTRAL_ENTRY_SIGNATURE
    ) {
      throw new Error('the central directory is damaged')
    }
    const nameLength = input.readUInt16LE(at + 28)
    const extraLength = input.readUInt16LE(at + 30)
    const commentLength = input.readUInt16LE(at + 32)
    crcs.set(
      input.toString('utf8', at + CENTRAL_ENTRY_BYTES, at + CENTRAL_ENTRY_BYTES + nameLength),
      input.readUInt32LE(at + 16)
    )
    at += CENTRAL_ENTRY_BYTES + nameLength + extraLength + commentLength
  }
  return crcs
}

function cleanOoxml(input: Buffer): Buffer | 'already_clean' {
  let total = 0
  let entries = 0
  const files = unzipSync(new Uint8Array(input), {
    filter: file => {
      entries += 1
      total += file.originalSize
      if (
        entries > DocumentSanitizing.MAX_ZIP_ENTRIES ||
        total > DocumentSanitizing.MAX_UNCOMPRESSED_BYTES
      ) {
        throw new Error('the package is too big to be opened')
      }
      return true
    }
  })
  // fflate inflates each part into a buffer of the size the zip declares and does not check anything else: a part whose real data is
  // longer would come out cut, and the cleaned package would be written over the original cut short. The CRC-32 that the central
  // directory holds for each part is the check
  const crcs = centralDirectoryCrcs(input)
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    if (crcs.get(path) !== crc32(data)) throw new Error('a part does not match its checksum')
  }
  if (files['[Content_Types].xml'] === undefined) throw new Error('not an office package')

  const rels = files[DocumentSanitizing.RELATIONSHIPS_PATH]
  const relsText = rels === undefined ? '' : strFromU8(rels)
  const thumbnails = new Set<string>()
  const properties = new Set<string>([DocumentSanitizing.CORE_PROPERTIES_PATH])
  const keptRels = relsText.replace(RELATIONSHIP, tag => {
    const type = attribute(tag, 'Type') ?? ''
    const target = packagePath(attribute(tag, 'Target') ?? '')
    if (type.endsWith(DocumentSanitizing.THUMBNAIL_RELATIONSHIP_SUFFIX)) {
      thumbnails.add(target)
      return ''
    }
    if (type.endsWith(DocumentSanitizing.CORE_RELATIONSHIP_SUFFIX)) properties.add(target)
    return tag
  })
  const thumbnail = new RegExp(DocumentSanitizing.THUMBNAIL_PATH_PATTERN)
  const replacements = new Map<string, string>([
    [DocumentSanitizing.APP_PROPERTIES_PATH, DocumentSanitizing.APP_PROPERTIES_XML],
    [DocumentSanitizing.CUSTOM_PROPERTIES_PATH, DocumentSanitizing.CUSTOM_PROPERTIES_XML]
  ])
  for (const path of properties) replacements.set(path, DocumentSanitizing.CORE_PROPERTIES_XML)

  // Local components, not a UTC instant: the zip writer reads them in the local time of the machine, and a date before 1980 there throws
  const date = new Date(DocumentSanitizing.ZIP_ENTRY_YEAR, 0, 1)
  const out: Zippable = {}
  let changed = keptRels !== relsText
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    if (thumbnails.has(path) || thumbnail.test(path)) {
      changed = true
      continue
    }
    let body: Uint8Array = data
    const replacement = replacements.get(path)
    if (replacement !== undefined) {
      body = strToU8(replacement)
      if (strFromU8(data) !== replacement) changed = true
    } else if (path === DocumentSanitizing.RELATIONSHIPS_PATH && keptRels !== relsText) {
      body = strToU8(keptRels)
    }
    out[path] = [body, { level: DocumentSanitizing.ZIP_LEVEL, mtime: date }]
  }
  if (!changed) return 'already_clean'
  const zipped = Buffer.from(zipSync(out))
  // Read back: it opens again and has every part but the thumbnail, each with the size it had
  const again = unzipSync(new Uint8Array(zipped))
  for (const path of Object.keys(out)) {
    if (again[path] === undefined) throw new Error('the cleaned package lost a part')
  }
  return zipped
}

// The one place where a PDF, a docx or an xlsx that is not financial evidence is cleaned of its properties, inside the decode slot of the
// cleaner (one at a time per process, the document is read whole). It never refuses: a document that cannot be cleaned without risk
// (encrypted, damaged, too big once opened) is `not_cleanable` and the caller keeps it as it came. An error of the machine propagates.
export function sanitizeDocument(
  input: Buffer,
  contentType: string,
  maxBytes: number = UploadLimits.MAX_FILE_SIZE_BYTES
): Promise<SanitizedDocument> {
  if (!isSanitizedDocumentType(contentType))
    return Promise.resolve({ kind: 'untouched', why: 'type' })
  return withDecodeSlot(async (): Promise<SanitizedDocument> => {
    let cleaned: Buffer | 'already_clean'
    try {
      cleaned =
        contentType === DocumentSanitizing.PDF_CONTENT_TYPE
          ? await cleanPdf(input)
          : cleanOoxml(input)
    } catch (error) {
      // An error of the machine is not the document's: the queue retries
      if (isEnvironmentError(error)) throw error
      return { kind: 'untouched', why: 'not_cleanable' }
    }
    if (cleaned === 'already_clean') return { kind: 'untouched', why: 'already_clean' }
    // A rewrite that came out bigger than the limit is not worth it
    if (cleaned.length > maxBytes) return { kind: 'untouched', why: 'not_cleanable' }
    return { kind: 'sanitized', body: cleaned }
  })
}
