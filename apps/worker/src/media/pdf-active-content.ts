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
const ACTIVE = new Set<string>(PdfInspection.ACTIVE_NAMES)
const LENGTH = /\/Length\s+(\d+)(?!\s+\d+\s+R)/
const END_MARK = 'endstream'

const decodeName = (raw: string): string =>
  raw.replace(HEX_ESCAPE, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

const namesIn = (text: string): string[] =>
  [...text.matchAll(NAME)].map(match => decodeName(match[1] ?? ''))

// The `obj` keyword that opens the object a stream belongs to (not the one inside `endobj`)
function objectStart(text: string, before: number): number {
  let at = text.lastIndexOf('obj', before)
  while (at > 2 && text.slice(at - 3, at) === 'end') at = text.lastIndexOf('obj', at - 1)
  return Math.max(at, 0)
}

// Where the data of a stream ends: by its /Length when that is a direct number that lands on `endstream`, and
// by the first `endstream` otherwise. A deflate block may hold the word, so the length goes first.
function dataEnd(text: string, dictionary: string, from: number): number {
  const declared = LENGTH.exec(dictionary)?.[1]
  if (declared !== undefined) {
    const end = from + Number(declared)
    if (/^\r?\n?endstream/.test(text.slice(end, end + END_MARK.length + 2))) return end
  }
  return text.indexOf(END_MARK, from)
}

// What a PDF that stays as the evidence of a transaction carries that runs when it is opened (TAX-436). It reads
// the file as bytes: the names in the clear, and those inside its object streams, the one place where a
// catalog can hide from a plain look. Pictures, fonts and page content hold no objects and are not read. It
// fails closed: an encrypted file, an object stream that is announced but cannot be read (it does not
// inflate, passes the limit, never ends) or a file with too many of them come back `unreadable`.
export function inspectPdf(bytes: Uint8Array): PdfInspectionResult {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = buffer.toString('latin1')
  const found = new Set<string>()
  const read = (source: string): string[] => {
    const names = namesIn(source)
    for (const name of names) if (ACTIVE.has(name)) found.add(name)
    return names
  }
  const unreadable = (reason: string): PdfInspectionResult => ({
    names: [...found],
    unreadable: reason
  })

  const wholeFile = read(text)
  const announced = wholeFile.filter(name => name === PdfInspection.OBJECT_STREAM_NAME).length
  if (wholeFile.includes(PdfInspection.ENCRYPT_NAME))
    return unreadable(PdfInspection.UNREADABLE.ENCRYPTED)

  let at = 0
  let objectStreams = 0
  for (;;) {
    const open = text.indexOf('stream', at)
    if (open === -1) break
    at = open + 'stream'.length
    // `endstream` holds the word too
    if (text.slice(Math.max(0, open - 3), open) === 'end') continue
    let from = at
    if (text[from] === '\r') from += 1
    if (text[from] !== '\n') continue
    from += 1
    const dictionary = text.slice(objectStart(text, open), open)
    if (!namesIn(dictionary).includes(PdfInspection.OBJECT_STREAM_NAME)) continue
    objectStreams += 1
    if (objectStreams > PdfInspection.MAX_OBJECT_STREAMS)
      return unreadable(PdfInspection.UNREADABLE.TOO_MANY_OBJECT_STREAMS)
    const end = dataEnd(text, dictionary, from)
    if (end === -1) return unreadable(PdfInspection.UNREADABLE.OBJECT_STREAM_UNREADABLE)
    try {
      read(
        inflateSync(buffer.subarray(from, end), {
          maxOutputLength: PdfInspection.MAX_INFLATED_BYTES_PER_STREAM
        }).toString('latin1')
      )
    } catch {
      return unreadable(PdfInspection.UNREADABLE.OBJECT_STREAM_UNREADABLE)
    }
    at = end
  }
  // An object stream that was announced and never tied to a stream we read (its marker was hidden from
  // the dictionary we looked at): nothing can be said about what it holds
  if (objectStreams < announced)
    return unreadable(PdfInspection.UNREADABLE.OBJECT_STREAM_UNREADABLE)
  return { names: [...found], unreadable: null }
}
