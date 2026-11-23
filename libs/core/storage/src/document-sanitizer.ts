import { crc32 } from 'node:zlib'

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import {
  PDFArray,
  type PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream
} from 'pdf-lib'

import {
  DocumentSanitizing,
  FILE_SIGNATURE_WINDOW_BYTES,
  ImageSanitizing,
  matchesDeclaredType,
  UploadLimits
} from '@platform/core/storage'

import { isEnvironmentError } from './environment-error'
import { carriesMetadata, sanitizeImage } from './image-sanitizer'
import { cutJpegMetadata, jpegCarriesMetadata } from './jpeg-metadata-cutter'

export { isEnvironmentError }

// What came of cleaning a document. A document is never refused for failing to clean: it is kept as it came, with its reason, so that the
// caller can log it (the document is the customer's own, and refusing it would lose a real file for a property block).
// `keptParts` counts what the cleaning meant to reach and left as it came (a photo that could not be decoded or that came after the time
// budget, a list of relationships that could not be read): the document is cleaned of the rest, and the caller logs the count with the id.
export type SanitizedDocument =
  | { kind: 'sanitized'; body: Buffer; keptParts: number }
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
const SUBTYPE_KEY = PDFName.of('Subtype')
const FILTER_KEY = PDFName.of('Filter')
const LENGTH_KEY = PDFName.of('Length')
const IMAGE_NAME = PDFName.of('Image')
const DCT_FILTER = PDFName.of('DCTDecode')

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

// The pictures of the PDF that are a JPEG file as it came (the only filter is `DCTDecode`) and that carry EXIF, XMP, IPTC or a comment. A
// picture under another filter (`FlateDecode` is raw pixels, with nothing to hold a position) or under two (the JPEG is inside another
// encoding) is not read: its metadata, if any, stays, and the plan says so.
function jpegsWithMetadata(context: PDFContext): [PDFRef, PDFRawStream][] {
  const found: [PDFRef, PDFRawStream][] = []
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue
    const { dict } = object
    if (dict.lookup(SUBTYPE_KEY) !== IMAGE_NAME) continue
    const filter = dict.lookup(FILTER_KEY)
    const only = filter instanceof PDFArray && filter.size() === 1 ? filter.lookup(0) : filter
    if (only !== DCT_FILTER) continue
    if (jpegCarriesMetadata(object.contents)) found.push([ref, object])
  }
  return found
}

// How many blocks of properties a document holds (the check of the cleaning: zero once it is cleaned)
function propertyBlocks(doc: PDFDocument): number {
  const { context } = doc
  let found = (context.trailerInfo.Info === undefined ? 0 : 1) + jpegsWithMetadata(context).length
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
  // The photos that came as a JPEG file: the segments of EXIF, XMP, IPTC and comments are cut and every other byte is kept, so the image
  // dictionary (size, colour space, decode) still describes the bytes. The object stays at its number: nothing that points to it changes.
  for (const [ref, stream] of jpegsWithMetadata(context)) {
    const cut = cutJpegMetadata(stream.contents)
    if (cut === undefined) continue
    stream.dict.set(LENGTH_KEY, PDFNumber.of(cut.length))
    context.assign(ref, PDFRawStream.of(stream.dict, cut))
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

// ---- the paths of the author's machine -------------------------------------------------------------------------------------------
// A docx or an xlsx remembers where it came from: in an xlsx `xl/workbook.xml` names the folder it was last saved in (`x15ac:absPath`,
// `C:\Users\<name>\Documents\...`), in a docx `word/_rels/settings.xml.rels` names the template it was made from (`attachedTemplate`,
// `file:///C:/Users/<name>/...Normal.dotm`), and any relationship that points to a local file (a linked workbook, a link to a file) holds
// the path of the machine that made it. The rule is per part and the most careful one that leaves the document openable: the value is
// replaced by a neutral local one, never removed, because the document refers to a relationship by its id and an element of the part
// may require its attribute. A missing template or linked file is what a document finds when it is opened on another machine, so
// nothing the reader sees changes.
const LOCAL_TARGET = /^(?:file:|[a-z]:[\\/]|\\\\)/i
// A character reference of XML (`&#67;`, `&#x43;`) written for a letter of the path: it is read before the target is judged, so that writing
// the drive letter as a reference does not keep the path. The count is bounded by the length of the target, which the caller bounds
const CHARACTER_REFERENCE = /&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi
const decodeReferences = (value: string): string =>
  value
    .replace(CHARACTER_REFERENCE, (whole, hex: string | undefined, decimal: string | undefined) => {
      const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
    .replace(/&amp;/g, '&')
const PART_OF_RELATIONSHIPS = /(?:^|\/)_rels\/[^/]+\.rels$/
// What an element prefix may be made of (a name of XML, no more): anything else before `absPath` is not the start of an element
const ELEMENT_PREFIX = /^[A-Za-z_][\w.-]*:$|^$/

function setAttribute(tag: string, name: string, value: string): string {
  return tag.replace(
    new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`),
    (_whole, head: string) => `${head}"${value}"`
  )
}

// The relationships that point outside the package to a place on a machine (a file, a drive, a network share, a rooted path): their target
// is replaced. A web address, a mail address and a path relative to the package are the customer's content and stay.
function neutralizeLocalTargets(relationships: string): string {
  return mapRelationships(relationships, tag => {
    if (attribute(tag, 'TargetMode')?.toLowerCase() !== 'external') return tag
    const target = decodeReferences(attribute(tag, 'Target') ?? '').trim()
    return LOCAL_TARGET.test(target)
      ? setAttribute(tag, 'Target', DocumentSanitizing.NEUTRAL_LOCAL_TARGET)
      : tag
  })
}

// The `url` of every `x15ac:absPath` element of a workbook, one element at a time: each step moves forward to a `>` it finds once, and the
// look back for the `<` of the element is bounded, because the part is the customer's and a part of `absPath` repeated would cost time that
// grows with the square of its size if every one searched back to the start. An element that does not close within the bound is left (the
// caller counts it).
function neutralizeAbsolutePaths(workbook: string, onLeft: () => void): string {
  const NAME = DocumentSanitizing.ABSOLUTE_PATH_ELEMENT
  let out = ''
  let at = 0
  // The next `>` is looked for once per stretch of text, not once per element: when there is none, every later element knows it
  let nextClose = -2
  for (;;) {
    const found = workbook.indexOf(NAME, at)
    if (found < 0) break
    let open = found - 1
    const limit = Math.max(at, found - DocumentSanitizing.MAX_ELEMENT_PREFIX_BYTES)
    while (open >= limit && workbook.charAt(open) !== '<') open -= 1
    const isElement =
      open >= limit && ELEMENT_PREFIX.test(workbook.slice(open + 1, found)) && open >= at
    if (isElement && nextClose !== -1 && nextClose < found) nextClose = workbook.indexOf('>', found)
    const close = isElement ? nextClose : -1
    if (!isElement) {
      out += workbook.slice(at, found + NAME.length)
      at = found + NAME.length
      continue
    }
    if (close < 0 || close - open > DocumentSanitizing.MAX_PATH_TAG_BYTES) {
      onLeft()
      out += workbook.slice(at, found + NAME.length)
      at = found + NAME.length
      continue
    }
    const tag = workbook.slice(open, close + 1)
    // A tag has no `<` inside: another one before the `>` means this element never closed
    if (tag.indexOf('<', 1) !== -1) {
      onLeft()
      out += workbook.slice(at, found + NAME.length)
      at = found + NAME.length
      continue
    }
    out +=
      workbook.slice(at, open) +
      setAttribute(
        tag,
        DocumentSanitizing.ABSOLUTE_PATH_ATTRIBUTE,
        DocumentSanitizing.NEUTRAL_LOCAL_PATH
      )
    at = close + 1
  }
  return out + workbook.slice(at)
}

// ---- the photos inside a docx or an xlsx -----------------------------------------------------------------------------------------
// Each photo of `word/media` and `xl/media` is a file like a picture upload and may carry EXIF with the position it was taken at. The
// cleaner of pictures is the one that cleans it (a still picture is decoded and encoded again, an animated gif is cut in its container),
// one at a time inside its decode slot, and only a photo that carries metadata is touched (a clean one stays as it came, bit for bit). The
// type is the one the bytes have, never the extension, and stays the same; a photo that cannot be cleaned, or that comes after the time
// budget, is kept as it came and counted.
const photoTypeOf = (data: Uint8Array): string | undefined =>
  ImageSanitizing.CONTENT_TYPES.find(type =>
    matchesDeclaredType(type, data.subarray(0, FILE_SIGNATURE_WINDOW_BYTES))
  )

const isPhotoPart = (path: string): boolean =>
  DocumentSanitizing.EMBEDDED_IMAGE_DIRECTORIES.some(directory => path.startsWith(directory))

async function cleanPhotos(
  files: Record<string, Uint8Array>,
  onKept: () => void
): Promise<Map<string, Uint8Array>> {
  const cleaned = new Map<string, Uint8Array>()
  const deadline = Date.now() + DocumentSanitizing.EMBEDDED_IMAGES_BUDGET_MS
  for (const [path, data] of Object.entries(files)) {
    const type = isPhotoPart(path) && !path.endsWith('/') ? photoTypeOf(data) : undefined
    if (type === undefined) continue
    const photo = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    try {
      if (!(await carriesMetadata(photo))) continue
      if (Date.now() >= deadline) {
        onKept()
        continue
      }
      const result = await sanitizeImage(photo, type, UploadLimits.MAX_FILE_SIZE_BYTES)
      if (result.kind === 'sanitized') cleaned.set(path, new Uint8Array(result.body))
      else onKept()
    } catch (error) {
      // An error of the machine is not the photo's: it stops the document, and the queue retries
      if (isEnvironmentError(error)) throw error
      onKept()
    }
  }
  return cleaned
}

async function cleanOoxml(
  input: Buffer
): Promise<{ body: Buffer; keptParts: number } | 'already_clean'> {
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
  const keptRels = neutralizeLocalTargets(
    mapRelationships(relsText, tag => {
      const type = attribute(tag, 'Type') ?? ''
      const target = packagePath(attribute(tag, 'Target') ?? '')
      if (type.endsWith(DocumentSanitizing.THUMBNAIL_RELATIONSHIP_SUFFIX)) {
        thumbnails.add(target)
        return ''
      }
      if (type.endsWith(DocumentSanitizing.CORE_RELATIONSHIP_SUFFIX)) properties.add(target)
      return tag
    })
  )
  const thumbnail = new RegExp(DocumentSanitizing.THUMBNAIL_PATH_PATTERN)
  const replacements = new Map<string, string>([
    [DocumentSanitizing.APP_PROPERTIES_PATH, DocumentSanitizing.APP_PROPERTIES_XML],
    [DocumentSanitizing.CUSTOM_PROPERTIES_PATH, DocumentSanitizing.CUSTOM_PROPERTIES_XML]
  ])
  for (const path of properties) replacements.set(path, DocumentSanitizing.CORE_PROPERTIES_XML)

  // What stays as it came and could not be read or cleaned is counted, so that the caller can log it with the id of the document
  let keptParts = 0
  const kept = (): void => {
    keptParts += 1
  }
  // The parts whose text carries a path of the machine: the lists of relationships of the other parts (the one of the package is above)
  // and the workbook. A list past the cap, or one that never closes, is left as it came and counted: it never stops the document
  const rewritten = new Map<string, string>()
  for (const [path, data] of Object.entries(files)) {
    if (path === DocumentSanitizing.RELATIONSHIPS_PATH) continue
    if (PART_OF_RELATIONSHIPS.test(path)) {
      if (data.length > DocumentSanitizing.MAX_RELATIONSHIPS_BYTES) {
        kept()
        continue
      }
      const text = strFromU8(data)
      try {
        const neutral = neutralizeLocalTargets(text)
        if (neutral !== text) rewritten.set(path, neutral)
      } catch {
        kept()
      }
    } else if (path === DocumentSanitizing.WORKBOOK_PATH) {
      const text = strFromU8(data)
      const neutral = neutralizeAbsolutePaths(text, kept)
      if (neutral !== text) rewritten.set(path, neutral)
    }
  }
  const photos = await cleanPhotos(files, kept)

  // Local components, not a UTC instant: the zip writer reads them in the local time of the machine, and a date before 1980 there throws
  const date = new Date(DocumentSanitizing.ZIP_ENTRY_YEAR, 0, 1)
  const out: Zippable = {}
  const touched = new Set<string>()
  let changed = keptRels !== relsText
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    if (thumbnails.has(path) || thumbnail.test(path)) {
      changed = true
      continue
    }
    let body: Uint8Array = data
    const replacement = replacements.get(path)
    const photo = photos.get(path)
    const text = rewritten.get(path)
    if (replacement !== undefined) {
      body = strToU8(replacement)
      touched.add(path)
      if (strFromU8(data) !== replacement) changed = true
    } else if (path === DocumentSanitizing.RELATIONSHIPS_PATH && keptRels !== relsText) {
      body = strToU8(keptRels)
      touched.add(path)
    } else if (text !== undefined) {
      body = strToU8(text)
      touched.add(path)
      changed = true
    } else if (photo !== undefined) {
      body = photo
      touched.add(path)
      changed = true
    }
    out[path] = [body, { level: DocumentSanitizing.ZIP_LEVEL, mtime: date }]
  }
  if (!changed) return 'already_clean'
  const zipped = Buffer.from(zipSync(out))
  // Read back: it opens again, has every part but the thumbnail and no other, and every part that the cleaning did not mean to change is
  // the same bytes; what it did change is clean (no path of a machine left in the text, no metadata in a photo)
  const again = unzipSync(new Uint8Array(zipped))
  const againPaths = Object.keys(again).filter(path => !path.endsWith('/'))
  if (againPaths.length !== Object.keys(out).length) {
    throw new Error('the cleaned package does not have the parts it should')
  }
  for (const path of Object.keys(out)) {
    const part = again[path]
    if (part === undefined) throw new Error('the cleaned package lost a part')
    if (!touched.has(path) && !Buffer.from(part).equals(Buffer.from(files[path] as Uint8Array))) {
      throw new Error('a part that was not to change is not the same')
    }
  }
  for (const [path, text] of rewritten) {
    const part = again[path]
    const now = part === undefined ? '' : strFromU8(part)
    const again2 =
      path === DocumentSanitizing.WORKBOOK_PATH
        ? neutralizeAbsolutePaths(now, () => undefined)
        : neutralizeLocalTargets(now)
    if (now !== text || again2 !== now) throw new Error('a path of the machine is still there')
  }
  // The photos are the bytes the cleaner of pictures made and verified (it reads its own output for metadata before it returns it)
  for (const [path, cleaned] of photos) {
    const part = again[path]
    if (part === undefined || !Buffer.from(part).equals(Buffer.from(cleaned))) {
      throw new Error('a cleaned photo is not what was made')
    }
  }
  return { body: zipped, keptParts }
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
  let cleaned: { body: Buffer; keptParts: number } | 'already_clean'
  try {
    if (contentType === DocumentSanitizing.PDF_CONTENT_TYPE) {
      const pdf = await cleanPdf(input)
      cleaned = pdf === 'already_clean' ? pdf : { body: pdf, keptParts: 0 }
    } else {
      cleaned = await cleanOoxml(input)
    }
  } catch (error) {
    // An error of the machine is not the document's: the queue retries
    if (isEnvironmentError(error)) throw error
    return { kind: 'untouched', why: 'not_cleanable' }
  }
  if (cleaned === 'already_clean') return { kind: 'untouched', why: 'already_clean' }
  // A rewrite that came out bigger than the limit is not worth it
  if (cleaned.body.length > maxBytes) return { kind: 'untouched', why: 'not_cleanable' }
  return { kind: 'sanitized', body: cleaned.body, keptParts: cleaned.keptParts }
}
