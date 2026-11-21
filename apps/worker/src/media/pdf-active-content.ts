import { PdfInspection } from '@platform/core/storage'

// The rules of a name are in `PdfInspection`. One pass over the text, no backtracking.
const NAME = new RegExp(PdfInspection.NAME_PATTERN, 'g')
const HEX_ESCAPE = new RegExp(PdfInspection.HEX_ESCAPE_PATTERN, 'g')
const ACTIVE = new Set<string>(PdfInspection.ACTIVE_NAMES)

const decodeName = (raw: string): string =>
  raw.includes(PdfInspection.HEX_ESCAPE_MARK)
    ? raw.replace(HEX_ESCAPE, (_all, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, PdfInspection.HEX_RADIX))
      )
    : raw

// What a scan did, counted and not timed: the same on every machine, so a spec can hold the scan to a linear amount of work (a time
// flakes on a shared runner). Optional: a scan with no counter does exactly the same.
export interface PdfScanWork {
  // Passes over the whole text (one)
  passes: number
  // Characters of the text those passes examined (the length of the text, once)
  charsExamined: number
  // Names the pass read, and the characters of them that were decoded
  namesRead: number
  charsDecoded: number
}

export const newPdfScanWork = (): PdfScanWork => ({
  passes: 0,
  charsExamined: 0,
  namesRead: 0,
  charsDecoded: 0
})

// The ONE place where the text exists: it is made here from the bytes and never leaves, so no other function can traverse it and every
// pass over it is counted. What a regular expression does INSIDE a pass (backtracking) is not a count: the shape of the pattern is
// held by `pdf-active-content.spec.ts`.
function* namesOf(bytes: Uint8Array, work: PdfScanWork | undefined): Generator<string> {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    PdfInspection.TEXT_ENCODING
  )
  if (work !== undefined) {
    work.passes += 1
    work.charsExamined += text.length
  }
  for (const match of text.matchAll(NAME)) {
    if (work !== undefined) work.namesRead += 1
    yield match[1] ?? ''
  }
}

// The active names a PDF carries IN THE CLEAR (TAX-436): one linear pass over the bytes of a file that is already
// limited in size, nothing inflated and nothing parsed. BEST EFFORT, NOT A SANDBOX: objects inside compressed
// streams or written in a way this does not read are not seen; the file is only ever served as a download and has
// been scanned (see `PdfInspection`). It is deliberately NOT a PDF parser: a parser that is not the reader's own is
// a race that does not end (two readers read one file in two ways) and inflating is a way to exhaust the worker.
export function findActivePdfNames(bytes: Uint8Array, work?: PdfScanWork): string[] {
  const found = new Set<string>()
  for (const raw of namesOf(bytes, work)) {
    if (work !== undefined) work.charsDecoded += raw.length
    const name = decodeName(raw)
    if (ACTIVE.has(name)) found.add(name)
  }
  return [...found]
}
