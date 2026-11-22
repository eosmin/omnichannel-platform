import { crc32 } from 'node:zlib'

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import {
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream
} from 'pdf-lib'

import { DocumentSanitizing, UploadLimits } from '@platform/core/storage'

import { isEnvironmentError } from './environment-error'

export { isEnvironmentError }

// What came of cleaning a document. A document is never refused for failing to clean: it is kept as it came, with its reason, so that the
// caller can log it (the document is the customer's own, and refusing it would lose a real file for a property block).
export type SanitizedDocument =
  | { kind: 'sanitized'; body: Buffer }
  | { kind: 'untouched'; why: 'type' | 'already_clean' | 'not_cleanable' | 'timed_out' }

export const isSanitizedDocumentType = (contentType: string): boolean =>
  contentType === DocumentSanitizing.PDF_CONTENT_TYPE ||
  contentType === DocumentSanitizing.DOCX_CONTENT_TYPE ||
  contentType === DocumentSanitizing.XLSX_CONTENT_TYPE

// ---- PDF -------------------------------------------------------------------------------------------------------------------------
// What is removed: the document information (the object the trailer names as `Info`), every `/Metadata` (XMP) and `/PieceInfo` entry of every
// object, and the objects that nothing is reachable from the catalog to (pdf-lib keeps every object of the file, so the information
// dictionary and the XMP of an earlier revision of an incrementally saved file would otherwise stay as objects nothing points to). Nothing is
// decided by what an object looks like: an outline item has a `/Title` and an annotation a `/Subject`, and both are the customer's content.
const METADATA_KEY = PDFName.of('Metadata')
const PIECE_INFO_KEY = PDFName.of('PieceInfo')
const ANNOTATIONS_KEY = PDFName.of('Annots')

const dictOf = (object: unknown): PDFDict | undefined =>
  object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : undefined

// The tags ("5 0 R") of the objects that can be reached from the catalog by following references
function reachableFromCatalog(context: PDFContext): Set<string> {
  const seen = new Set<string>()
  const pending: unknown[] = [context.trailerInfo.Root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node instanceof PDFRef) {
      if (seen.has(node.tag)) continue
      seen.add(node.tag)
      pending.push(context.lookup(node))
    } else if (node instanceof PDFDict) {
      for (const [, value] of node.entries()) pending.push(value)
    } else if (node instanceof PDFStream) {
      pending.push(node.dict)
    } else if (node instanceof PDFArray) {
      for (let at = 0; at < node.size(); at += 1) pending.push(node.get(at))
    }
  }
  return seen
}

// An information dictionary: no `/Type`, and the keys that only the information has (the title and the subject are not enough: a bookmark
// and a comment have them)
const looksLikeInfo = (dict: PDFDict): boolean =>
  !dict.has(PDFName.of('Type')) &&
  !dict.has(PDFName.of('Subtype')) &&
  !dict.has(PDFName.of('Dest')) &&
  !dict.has(PDFName.of('Parent')) &&
  !dict.has(PDFName.of('A')) &&
  !dict.has(PDFName.of('Rect')) &&
  ['Producer', 'Creator', 'CreationDate', 'ModDate', 'Author'].some(key =>
    dict.has(PDFName.of(key))
  )

const isXmp = (dict: PDFDict): boolean =>
  dict.get(PDFName.of('Type')) === PDFName.of('Metadata') &&
  dict.get(PDFName.of('Subtype')) === PDFName.of('XML')

// How many blocks of properties a document holds (the check of the cleaning: zero once it is cleaned)
function propertyBlocks(doc: PDFDocument): number {
  const { context } = doc
  let found = context.trailerInfo.Info === undefined ? 0 : 1
  const reachable = reachableFromCatalog(context)
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    const dict = dictOf(object)
    if (dict === undefined) continue
    if (dict.has(METADATA_KEY) || dict.has(PIECE_INFO_KEY)) found += 1
    else if (!reachable.has(ref.tag) && (looksLikeInfo(dict) || isXmp(dict))) found += 1
  }
  return found
}

// What the customer sees and can click on, to be the same before and after: the objects that make the document, the pages, the comments
// of each page and whether it has bookmarks
function shape(doc: PDFDocument): string {
  const comments = doc
    .getPages()
    .map(page => page.node.lookupMaybe(ANNOTATIONS_KEY, PDFArray)?.size() ?? 0)
  return JSON.stringify([
    reachableFromCatalog(doc.context).size,
    doc.getPageCount(),
    comments,
    doc.catalog.has(PDFName.of('Outlines'))
  ])
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
  const info = context.trailerInfo.Info
  if (info instanceof PDFRef) context.delete(info)
  delete context.trailerInfo.Info
  for (const [, object] of context.enumerateIndirectObjects()) {
    const dict = dictOf(object)
    dict?.delete(METADATA_KEY)
    dict?.delete(PIECE_INFO_KEY)
  }
  // The XMP streams and the old information are now objects that nothing points to: they go, with any other object of an earlier revision
  const reachable = reachableFromCatalog(context)
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) context.delete(ref)
  }
  const expected = shape(doc)
  const saved = await doc.save({ useObjectStreams: false })
  // Read back: it must load again, look the same (pages, comments, bookmarks, objects) and carry no block of properties
  const again = await PDFDocument.load(saved, { updateMetadata: false, throwOnInvalidObject: true })
  if (propertyBlocks(again) !== 0 || shape(again) !== expected) {
    throw new Error('the cleaned pdf is not what it should be')
  }
  return Buffer.from(saved)
}

// ---- docx and xlsx ---------------------------------------------------------------------------------------------------------------
// The package is a zip: the property parts are written again empty (the author, the last editor, the dates, the company, the program), the
// thumbnail is removed with the relationship that points to it, and the zip is written again with a fixed entry date. The core properties
// are the part that the package relationships name (Word and Excel use `docProps/core.xml`, other writers use another path). The text, the
// styles, the sheets and the comments are the same bytes.
// The relationships of a package, one element at a time and without a regular expression that backtracks: the file is the customer's, and
// a regex with a lazy `[^>]*?` over a file of `<Relationship ` with no `>` costs time that grows with the square of its size. Each step
// here moves forward to a `>` it finds once, and a file with an element that never closes is refused.
function mapRelationships(text: string, onTag: (tag: string) => string): string {
  const START = '<Relationship'
  const CLOSING = '</Relationship'
  let out = ''
  let at = 0
  for (;;) {
    const start = text.indexOf(START, at)
    if (start < 0) break
    const next = text.charAt(start + START.length)
    // `<Relationships ...>` (the container) is not a relationship
    if (
      next !== ' ' &&
      next !== '/' &&
      next !== '>' &&
      next !== '\t' &&
      next !== '\n' &&
      next !== '\r'
    ) {
      out += text.slice(at, start + START.length)
      at = start + START.length
      continue
    }
    const open = text.indexOf('>', start)
    if (open < 0) throw new Error('a relationship never closes')
    let end = open + 1
    if (text.charAt(open - 1) !== '/') {
      const closing = text.indexOf(CLOSING, end)
      const closed = closing < 0 ? -1 : text.indexOf('>', closing)
      if (closed < 0) throw new Error('a relationship never closes')
      end = closed + 1
    }
    out += text.slice(at, start) + onTag(text.slice(start, end))
    at = end
  }
  return out + text.slice(at)
}

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
  // A real list of relationships is a few KB; a file past the cap is not worth the time of the worker, and the document is kept as it came
  if ((rels?.length ?? 0) > DocumentSanitizing.MAX_RELATIONSHIPS_BYTES) {
    throw new Error('the relationships are too big')
  }
  const relsText = rels === undefined ? '' : strFromU8(rels)
  const thumbnails = new Set<string>()
  const properties = new Set<string>([DocumentSanitizing.CORE_PROPERTIES_PATH])
  const keptRels = mapRelationships(relsText, tag => {
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
  // Read back: it opens again and has every part but the thumbnail
  const again = unzipSync(new Uint8Array(zipped))
  for (const path of Object.keys(out)) {
    if (again[path] === undefined) throw new Error('the cleaned package lost a part')
  }
  return zipped
}

// Cleans a PDF, a docx or an xlsx that is not financial evidence of its properties, ON THE THREAD THAT CALLS IT. The parse is synchronous and
// the file is the customer's, so a hostile or huge one holds that thread: nothing in the worker calls this on its main thread. The only
// caller is the entry of the document thread (`apps/worker/src/media/document-thread.entry.ts`), which the worker starts with a deadline and
// a memory limit (`DocumentCleaner`, `ThreadDocumentCleaner`); the specs of the cleaner call it too. It never refuses: a document that cannot be
// cleaned without risk (encrypted, damaged, too big once opened) is `not_cleanable` and the caller keeps it as it came. An error of the
// machine propagates.
export async function sanitizeDocumentInline(
  input: Buffer,
  contentType: string,
  maxBytes: number = UploadLimits.MAX_FILE_SIZE_BYTES
): Promise<SanitizedDocument> {
  if (!isSanitizedDocumentType(contentType)) return { kind: 'untouched', why: 'type' }
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
}
