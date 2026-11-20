import { inflateSync } from 'node:zlib'

import { PdfInspection } from '@platform/core/storage'

// A PDF name: a slash and the regular characters after it, up to a space or a delimiter. `/JSON` is the
// name JSON, never the name JS.
const NAME = /\/([^\s/[\]<>(){}%]+)/g
const HEX_ESCAPE = /#([0-9A-Fa-f]{2})/g
const ACTIVE = new Set<string>(PdfInspection.ACTIVE_NAMES)

const decodeName = (raw: string): string =>
  raw.replace(HEX_ESCAPE, (_all, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

function collect(text: string, found: Set<string>): void {
  for (const match of text.matchAll(NAME)) {
    const name = decodeName(match[1] ?? '')
    if (ACTIVE.has(name)) found.add(name)
  }
}

// The streams of the file: what lies between `stream` and `endstream`, with the dictionary that came before it
function* streams(text: string): Generator<{ dictionary: string; from: number; to: number }> {
  let at = 0
  let count = 0
  while (count < PdfInspection.MAX_STREAMS) {
    const open = text.indexOf('stream', at)
    if (open === -1) return
    at = open + 'stream'.length
    // `endstream` also contains the word
    if (text.slice(Math.max(0, open - 3), open) === 'end') continue
    let from = at
    if (text[from] === '\r') from += 1
    if (text[from] !== '\n') continue
    from += 1
    const close = text.indexOf('endstream', from)
    if (close === -1) return
    const objectStart = text.lastIndexOf('obj', open)
    count += 1
    yield { dictionary: text.slice(Math.max(objectStart, 0), open), from, to: close }
    at = close + 'endstream'.length
  }
}

// The names of active content a PDF carries (TAX-436), or none. It reads the file as bytes: the names in
// the clear, and those inside the streams that inflate (an object stream can hold the whole catalog). A
// picture is not inflated. What a reader would build from a filter this does not read (an encrypted file, a
// lossy or unknown filter) stays unseen: the scan and the type check are the other gates, and an encrypted
// PDF is its own debt in the plan.
export function findPdfActiveContent(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = buffer.toString('latin1')
  const found = new Set<string>()
  collect(text, found)
  for (const stream of streams(text)) {
    if (/\/Subtype\s*\/Image\b/.test(stream.dictionary)) continue
    try {
      const inflated = inflateSync(buffer.subarray(stream.from, stream.to), {
        maxOutputLength: PdfInspection.MAX_INFLATED_BYTES_PER_STREAM
      })
      collect(inflated.toString('latin1'), found)
    } catch {
      // Not a deflate stream, or one that inflates past the limit: not read
    }
  }
  return [...found]
}
