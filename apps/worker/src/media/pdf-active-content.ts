import { PdfInspection } from '@platform/core/storage'

// A PDF name: a slash and the regular characters after it, up to a space (NUL is one) or a delimiter. `/JSON` is the name JSON,
// never the name JS. One pass over the text, no backtracking.
const NAME = /\/([^\s\0/[\]<>(){}%]+)/g
const HEX_ESCAPE = /#([0-9A-Fa-f]{2})/g
const ACTIVE = new Set<string>(PdfInspection.ACTIVE_NAMES)

const decodeName = (raw: string): string =>
  raw.includes('#')
    ? raw.replace(HEX_ESCAPE, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    : raw

// The active names a PDF carries IN THE CLEAR (TAX-436): one linear pass over the bytes of a file that is already
// limited in size, nothing inflated and nothing parsed. BEST EFFORT, NOT A SANDBOX: objects inside compressed
// streams or written in a way this does not read are not seen; the file is only ever served as a download and has
// been scanned (see `PdfInspection`). It is deliberately NOT a PDF parser: a parser that is not the reader's own is
// a race that does not end (two readers read one file in two ways) and inflating is a way to exhaust the worker.
export function findActivePdfNames(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const found = new Set<string>()
  for (const match of text.matchAll(NAME)) {
    const name = decodeName(match[1] ?? '')
    if (ACTIVE.has(name)) found.add(name)
  }
  return [...found]
}
