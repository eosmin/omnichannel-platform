// How many leading bytes decide whether a file is what it says it is. Enough for every signature
// below and for a look at a text file; the rest of the file is the scan's and the decoder's.
export const FILE_SIGNATURE_WINDOW_BYTES = 8192

type Head = Uint8Array

const ascii = (head: Head, at: number, text: string): boolean =>
  text.length + at <= head.length &&
  [...text].every((char, i) => head[at + i] === char.charCodeAt(0))

const startsWith = (head: Head, bytes: readonly number[]): boolean =>
  bytes.length <= head.length && bytes.every((byte, i) => head[i] === byte)

// ISO base media (mp4) and QuickTime start with a box whose type sits at offset 4: `ftyp` for the
// modern ones, `moov`, `mdat`, `wide` or `free` for the oldest .mov files
const isMovie = (head: Head): boolean =>
  ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].some(box => ascii(head, 4, box))

// MPEG audio: an ID3 tag, or the 11 bits of frame sync
const isMpegAudio = (head: Head): boolean =>
  ascii(head, 0, 'ID3') ||
  (head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)

// Raw AAC (ADTS): 12 bits of sync, then a layer of 00. The looser test of MPEG audio above also lets
// these bytes through; the declared type decides which of the two a file is kept as
const isAdts = (head: Head): boolean =>
  head.length >= 2 && head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0

const isZip = (head: Head): boolean => startsWith(head, [0x50, 0x4b, 0x03, 0x04])

// A text file has no signature: what is refused is a binary one (a NUL byte, unless it is UTF-16 with its mark) dressed as text
// A text in UTF-16 (a Windows "Unicode" .txt) has NUL bytes and starts with its byte order mark
const isUtf16 = (head: Head): boolean =>
  head.length >= 2 &&
  ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
const isText = (head: Head): boolean => head.length > 0 && (isUtf16(head) || !head.includes(0))

const RULES: Readonly<Record<string, (head: Head) => boolean>> = {
  'image/jpeg': head => startsWith(head, [0xff, 0xd8, 0xff]),
  'image/png': head => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': head => ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a'),
  'image/webp': head => ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP'),
  'video/mp4': isMovie,
  'video/quicktime': isMovie,
  'audio/mpeg': isMpegAudio,
  // An m4a is an mp4 container like a video: the same boxes
  'audio/mp4': isMovie,
  'audio/aac': isAdts,
  'audio/ogg': head => ascii(head, 0, 'OggS'),
  'audio/wav': head => ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE'),
  'application/pdf': head => ascii(head, 0, '%PDF-'),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
  'text/plain': isText
}

// The types that have a rule: a test checks it covers every type an upload may declare
export const SIGNATURE_TYPES: readonly string[] = Object.keys(RULES)

// Whether the first bytes of a file are those of the type it was declared with. The declared type is
// the client's word: this is the server looking at the bytes, so an HTML page named `fake.png` and
// declared `image/png` is refused instead of being kept and served as a picture. A type with no rule
// is refused.
export function matchesDeclaredType(contentType: string, head: Head): boolean {
  // Own keys only: `toString` and `constructor` are not types
  if (!Object.hasOwn(RULES, contentType)) return false
  return RULES[contentType]?.(head) === true
}

// The first of `candidates` whose signature the bytes carry, or null: for a server that did not say
// what a file is
export function sniffDeclarableType(head: Head, candidates: readonly string[]): string | null {
  return candidates.find(type => matchesDeclaredType(type, head)) ?? null
}
