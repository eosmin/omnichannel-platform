import { inflateSync } from 'node:zlib'

import { PdfInspection } from '@platform/core/storage'

export interface PdfInspectionResult {
  // The active names the file carries
  names: string[]
  // Why nothing can be said about the file, or null: it must be refused as well
  unreadable: string | null
}

// A PDF name: a slash and the regular characters after it, up to a space or a delimiter. `/JSON` is the
// name JSON, never the name JS.
const NAME = /\/([^\s/[\]<>(){}%]+)/g
const HEX_ESCAPE = /#([0-9A-Fa-f]{2})/g
const FILTER = /\/Filter\s*(\[[^\]]*\]|\/[^\s/[\]<>(){}%]+)/
const LENGTH = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/
const REFERENCE = /^\s*(\d+)\s+(\d+)\s+R\b/
const HEADER_END = /(\d+)\s+(\d+)\s+obj\s*$/
const AFTER_KEYWORD = /^[ \t]*(\r\n|\n|\r)/
const ACTIVE = new Set<string>(PdfInspection.ACTIVE_NAMES)
const CARRIERS = new Set<string>(PdfInspection.CARRIER_NAMES)
const CARRIER_ACTIVE = new Set<string>(PdfInspection.CARRIER_ACTIVE_NAMES)
const { STREAM, END_STREAM, OBJ, END_OBJ } = PdfInspection.SYNTAX
const { UNREADABLE } = PdfInspection

// The check ends at the first thing that cannot be proven: the reason travels up as this
class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

const decodeName = (raw: string): string =>
  raw.includes('#')
    ? raw.replace(HEX_ESCAPE, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    : raw

const isWordChar = (char: string | undefined): boolean =>
  char !== undefined && /[A-Za-z0-9]/.test(char)

// What a PDF that stays as the evidence of a transaction carries that runs when it is opened (TAX-436). It reads
// the file as bytes: the names in the clear, and those inside its object streams, the one place where a catalog
// can hide from a plain look. Pictures, fonts and page content hold no objects and are not read. The rule is to
// fail closed: once the file has an object stream, every `stream` has to be recognised (its own `N G obj`, its
// own dictionary, no `endobj` in between), every object stream has to inflate whole within the limits, and the
// work is bounded in names, keywords, bytes and time. Whatever is not proven inert comes back `unreadable`.
export function inspectPdf(bytes: Uint8Array): PdfInspectionResult {
  const found = new Set<string>()
  try {
    scanFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), found)
    return { names: [...found], unreadable: null }
  } catch (error) {
    return {
      names: [...found],
      unreadable: error instanceof Refused ? error.reason : UNREADABLE.INSPECTION_FAILED
    }
  }
}

function scanFile(buffer: Buffer, found: Set<string>): void {
  const deadline = Date.now() + PdfInspection.TIME_BUDGET_MS
  const onTime = (): void => {
    if (Date.now() > deadline) throw new Refused(UNREADABLE.TIME_BUDGET_EXCEEDED)
  }
  let names = 0
  let carriers = 0

  // A destination (`[3 0 R /Fit]`) is not an action. An action that is a dictionary is active when it names a
  // link or anything of the list (those are found on their own as well); a reference is followed once; anything
  // else (a value that is not understood, a reference that is not there) is active.
  const carrierIsActive = (source: string, from: number, followed: boolean): boolean => {
    const rest = source.slice(from, from + PdfInspection.PEEK_BYTES)
    if (/^\s*\[/.test(rest)) return false
    if (/^\s*<</.test(rest)) {
      for (const match of rest.matchAll(NAME)) {
        const name = decodeName(match[1] ?? '')
        if (ACTIVE.has(name) || CARRIER_ACTIVE.has(name)) return true
      }
      return false
    }
    const reference = REFERENCE.exec(rest)
    if (reference === null || followed) return true
    const header = `${reference[1]} ${reference[2]} ${OBJ}`
    let at = source.indexOf(header)
    for (let tries = 0; at > 0 && /\d/.test(source[at - 1] ?? '') && tries < 50; tries += 1)
      at = source.indexOf(header, at + 1)
    if (at === -1 || (at > 0 && /\d/.test(source[at - 1] ?? ''))) return true
    return carrierIsActive(source, at + header.length, true)
  }

  // Looks at every name of a text. Returns how many object stream markers it holds.
  const read = (source: string): number => {
    let markers = 0
    for (const match of source.matchAll(NAME)) {
      names += 1
      if (names > PdfInspection.MAX_NAMES) throw new Refused(UNREADABLE.TOO_MANY_NAMES)
      if (names % 4096 === 0) onTime()
      const name = decodeName(match[1] ?? '')
      if (name === PdfInspection.OBJECT_STREAM_NAME) markers += 1
      else if (name === PdfInspection.ENCRYPT_NAME) throw new Refused(UNREADABLE.ENCRYPTED)
      else if (CARRIERS.has(name)) {
        carriers += 1
        if (carriers > PdfInspection.MAX_CARRIERS)
          throw new Refused(UNREADABLE.TOO_MANY_STREAM_KEYWORDS)
        if (carrierIsActive(source, (match.index ?? 0) + match[0].length, false)) found.add(name)
      } else if (ACTIVE.has(name)) found.add(name)
    }
    return markers
  }

  const text = buffer.toString('latin1')
  const announced = read(text)
  if (announced === 0) return

  // From here the file has object streams, so every `stream` has to be accounted for
  let at = 0
  let keywords = 0
  let objectStreams = 0
  let inflated = 0
  for (;;) {
    const open = text.indexOf(STREAM, at)
    if (open === -1) break
    at = open + STREAM.length
    // The word inside another (`endstream`, `upstream`, `streams`) is not the keyword
    const before = text[open - 1]
    if (before !== undefined && !/[\s>]/.test(before)) continue
    const after = AFTER_KEYWORD.exec(text.slice(at, at + 8))
    if (after === null) {
      if (isWordChar(text[at])) continue
      throw new Refused(UNREADABLE.UNRECOGNISED_STREAM)
    }
    keywords += 1
    if (keywords > PdfInspection.MAX_STREAM_KEYWORDS)
      throw new Refused(UNREADABLE.TOO_MANY_STREAM_KEYWORDS)
    if (keywords % 256 === 0) onTime()

    // The dictionary of this stream: after the last `N G obj` of the window, with no `endobj` in between
    const window = text.slice(Math.max(0, open - PdfInspection.DICTIONARY_WINDOW_BYTES), open)
    const closed = window.lastIndexOf(END_OBJ)
    const segment = closed === -1 ? window : window.slice(closed + END_OBJ.length)
    const keyword = segment.lastIndexOf(OBJ)
    if (keyword === -1 || !HEADER_END.test(segment.slice(0, keyword + OBJ.length)))
      throw new Refused(UNREADABLE.UNRECOGNISED_STREAM)
    const dictionary = segment.slice(keyword + OBJ.length)
    if (!/^\s*<<[\s\S]*>>\s*$/.test(dictionary)) throw new Refused(UNREADABLE.UNRECOGNISED_STREAM)

    const dictionaryNames = [...dictionary.matchAll(NAME)].map(match => decodeName(match[1] ?? ''))
    if (!dictionaryNames.includes(PdfInspection.OBJECT_STREAM_NAME)) continue
    objectStreams += 1
    if (objectStreams > PdfInspection.MAX_OBJECT_STREAMS)
      throw new Refused(UNREADABLE.TOO_MANY_OBJECT_STREAMS)

    // Only a deflate stream (or none) is undone, and without parameters (no predictor): anything else is a chain
    // this does not undo, and what a reader would build from it stays unseen
    const declared = FILTER.exec(dictionary)?.[1]
    const filters =
      declared === undefined ? [] : [...declared.matchAll(NAME)].map(m => decodeName(m[1] ?? ''))
    const plain = !dictionaryNames.includes(PdfInspection.FILTER_NAME)
    const flate = filters.length === 1 && filters[0] === PdfInspection.READABLE_FILTER
    if (
      (!plain && !flate) ||
      dictionaryNames.some(name =>
        PdfInspection.PARAMETER_NAMES.some(parameter => parameter === name)
      )
    )
      throw new Refused(UNREADABLE.UNSUPPORTED_FILTER)

    const from = at + after[0].length
    const end = dataEnd(text, dictionary, from)
    if (end === -1) throw new Refused(UNREADABLE.OBJECT_STREAM_UNREADABLE)
    let objects: Buffer
    try {
      const data = buffer.subarray(from, end)
      objects = plain
        ? data
        : inflateSync(data, { maxOutputLength: PdfInspection.MAX_INFLATED_BYTES_PER_STREAM })
    } catch {
      throw new Refused(UNREADABLE.OBJECT_STREAM_UNREADABLE)
    }
    inflated += objects.length
    if (inflated > PdfInspection.MAX_INFLATED_BYTES_TOTAL)
      throw new Refused(UNREADABLE.OBJECT_STREAM_UNREADABLE)
    read(objects.toString('latin1'))
    // The scan goes on from the keyword, not from the end: a stream that lies inside the range another one
    // declares is still seen
  }
  // An object stream announced by its name that was never recognised as one: its marker was hidden
  if (objectStreams < announced) throw new Refused(UNREADABLE.OBJECT_STREAM_UNREADABLE)
}

// Where the data of a stream ends: by its /Length when that is a direct number that lands on `endstream`, and
// by the first `endstream` otherwise. A deflate block may hold the word, so the length goes first.
function dataEnd(text: string, dictionary: string, from: number): number {
  const declared = LENGTH.exec(dictionary)?.[1]
  if (declared !== undefined) {
    const end = from + Number(declared)
    if (/^\r?\n?endstream/.test(text.slice(end, end + END_STREAM.length + 2))) return end
  }
  return text.indexOf(END_STREAM, from)
}
