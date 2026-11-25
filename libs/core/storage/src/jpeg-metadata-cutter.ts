// A JPEG is a list of segments: `FF <marker>` and, for most, two bytes of length (that count themselves) and the payload, until the start of the
// scan (`FFDA`), after which comes the image data and the end (`FFD9`). The metadata of a photograph lives in segments of their own: EXIF and
// XMP in `APP1` (where the position, the camera and the time are), the Photoshop and IPTC block in `APP13`, and the free text of a comment in
// `COM`; a camera of action, a drone or a C2PA signer writes more (telemetry with the position in `APP6`, a manifest in `APP11`), so the cut is a
// LIST OF WHAT STAYS and not of what goes: the structural markers and the three application segments that drawing needs (JFIF, the colour
// profile, Adobe's colour transform) stay, every other application segment and every comment goes. Cutting those segments out leaves every other byte as it was, so the picture is the same pixels, the same colour space and the same
// size: what a PDF that embeds the file with its `DCTDecode` filter needs, because the image dictionary of the PDF (colour space, width,
// height, decode array) describes the bytes of the JPEG and a new encoding would have to rewrite it. The JPEG of a docx or an xlsx is cleaned
// by the cleaner of pictures instead (`image-sanitizer.ts`), which decodes and encodes it again.
const MARKER_PREFIX = 0xff
const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const APP0 = 0xe0
const APP2 = 0xe2
const APP14 = 0xee
const APP_FIRST = 0xe0
const APP_LAST = 0xef
const COM = 0xfe
const JFIF_IDENTIFIER = 'JFIF\0'
const ICC_IDENTIFIER = 'ICC_PROFILE\0'
const ADOBE_IDENTIFIER = 'Adobe'
const TEM = 0x01
const STUFFED_ZERO = 0x00
const RST_FIRST = 0xd0
const RST_LAST = 0xd7
const SEGMENT_HEADER_BYTES = 2
const LENGTH_BYTES = 2

// Whether a segment is one that stays: not an application segment or a comment, or one of the three that drawing needs and that is what it
// says it is (the colour profile and Adobe's transform are told by the first bytes of their payload; an `APP2` that is a multi-picture index
// or a FlashPix extension is not a colour profile)
function staysInPicture(jpeg: Uint8Array, marker: number, start: number, end: number): boolean {
  if (marker === COM) return false
  if (marker < APP_FIRST || marker > APP_LAST) return true
  const payload = Buffer.from(jpeg.subarray(start + SEGMENT_HEADER_BYTES + LENGTH_BYTES, end))
  // `APP0` stays only as the JFIF header. The extension `JFXX\0` carries a thumbnail (a picture of its own, which may hold an EXIF block), and
  // any other `APP0` is a program's own data
  if (marker === APP0) return payload.toString('latin1').startsWith(JFIF_IDENTIFIER)
  if (marker === APP2) return payload.toString('latin1').startsWith(ICC_IDENTIFIER)
  if (marker === APP14) return payload.toString('latin1').startsWith(ADOBE_IDENTIFIER)
  return false
}

// Markers that have no length and no payload
const isStandalone = (marker: number): boolean =>
  marker === SOI || marker === EOI || marker === TEM || (marker >= RST_FIRST && marker <= RST_LAST)

// Where the scan that starts at `at` (its `FFDA`) ends: the offset of the next marker. After the header of the scan comes entropy-coded data,
// where `FF 00` is a stuffed byte, `FF D0`..`FF D7` a restart and `FF FF` a fill byte; any other `FF xx` is the next marker. `undefined` when
// the header does not fit or the data reaches the end of the file with no marker after it (a truncated file is not walked)
function endOfScan(jpeg: Uint8Array, at: number): number | undefined {
  if (at + SEGMENT_HEADER_BYTES + LENGTH_BYTES > jpeg.length) return undefined
  const length = ((jpeg[at + 2] as number) << 8) | (jpeg[at + 3] as number)
  let i = at + SEGMENT_HEADER_BYTES + length
  if (length < LENGTH_BYTES || i > jpeg.length) return undefined
  for (;;) {
    i = jpeg.indexOf(MARKER_PREFIX, i)
    if (i < 0 || i + 1 >= jpeg.length) return undefined
    const next = jpeg[i + 1] as number
    if (next === MARKER_PREFIX) {
      i += 1
    } else if (next === STUFFED_ZERO || (next >= RST_FIRST && next <= RST_LAST)) {
      i += SEGMENT_HEADER_BYTES
    } else {
      return i
    }
  }
}

interface WalkedJpeg {
  // The spans of the segments that carry metadata, as [start, end) offsets
  spans: [number, number][]
  // The offset just after the `FFD9` that ends the first image, or `undefined` when a scan runs to the end of the file with no marker after
  // it (a truncated file or an encoder that left out the end): the segments before that scan are still walked and cut, as they always were,
  // but the file is not vouched for as a whole
  end: number | undefined
}

// Walks a JPEG from its first byte to the end of its first image, scan after scan (a progressive file has several, with tables and any
// application segment between them), or `undefined` when the bytes are not a JPEG that can be walked that way (a damaged or a truncated file
// is left as it is: it is never cut blind)
function walk(jpeg: Uint8Array): WalkedJpeg | undefined {
  if (jpeg.length < SEGMENT_HEADER_BYTES || jpeg[0] !== MARKER_PREFIX || jpeg[1] !== SOI) {
    return undefined
  }
  const spans: [number, number][] = []
  // Once a scan has been seen, a file that stops being walkable keeps the segments found before it (they are cut, as they always were) and
  // loses only its `end`: the file is not vouched for, but what sits before the scan is never left in it because of what comes after
  let scanned = false
  const unwalkable = (): WalkedJpeg | undefined => (scanned ? { spans, end: undefined } : undefined)
  let at = SEGMENT_HEADER_BYTES
  while (at < jpeg.length) {
    // Fill bytes (`FF FF`) may precede a marker
    while (at < jpeg.length && jpeg[at] === MARKER_PREFIX && jpeg[at + 1] === MARKER_PREFIX) at += 1
    if (jpeg[at] !== MARKER_PREFIX || at + 1 >= jpeg.length) return unwalkable()
    const marker = jpeg[at + 1] as number
    if (marker === EOI) return { spans, end: at + SEGMENT_HEADER_BYTES }
    if (marker === SOS) {
      scanned = true
      const next = endOfScan(jpeg, at)
      if (next === undefined) return unwalkable()
      at = next
      continue
    }
    if (isStandalone(marker)) {
      at += SEGMENT_HEADER_BYTES
      continue
    }
    if (at + SEGMENT_HEADER_BYTES + LENGTH_BYTES > jpeg.length) return unwalkable()
    const length = ((jpeg[at + 2] as number) << 8) | (jpeg[at + 3] as number)
    const end = at + SEGMENT_HEADER_BYTES + length
    if (length < LENGTH_BYTES || end > jpeg.length) return unwalkable()
    if (!staysInPicture(jpeg, marker, at, end)) spans.push([at, end])
    at = end
  }
  return unwalkable()
}

const metadataSpans = (jpeg: Uint8Array): [number, number][] | undefined => walk(jpeg)?.spans

// Whether a JPEG holds a segment of metadata that `cutJpegMetadata` would remove (false for a file that cannot be walked)
export function jpegCarriesMetadata(jpeg: Uint8Array): boolean {
  return (metadataSpans(jpeg)?.length ?? 0) > 0
}

// The JPEG without its metadata segments, or `undefined` when there is nothing to cut or the file cannot be walked (the caller keeps it as it
// came). Every byte that is not in a cut segment is copied as it was.
export function cutJpegMetadata(jpeg: Uint8Array): Uint8Array | undefined {
  const spans = metadataSpans(jpeg)
  if (spans === undefined || spans.length === 0) return undefined
  const cut = spans.reduce((sum, [start, end]) => sum + (end - start), 0)
  const out = new Uint8Array(jpeg.length - cut)
  let written = 0
  let from = 0
  for (const [start, end] of spans) {
    out.set(jpeg.subarray(from, start), written)
    written += start - from
    from = end
  }
  out.set(jpeg.subarray(from), written)
  return out
}

// Whether a JPEG holds anything after the end of its first image (the trailer of a phone, a secondary image of a multi-picture file, a
// depth map or a gain map that carries an EXIF block of its own). A cut of the segments of the first image leaves all of it as it was, and the
// header that is read back describes the first image only, so the caller must not take such a file as cleaned. Zero padding is not data. A
// file that cannot be walked to the end of its first image is not vouched for either.
export function jpegHasDataAfterEnd(jpeg: Uint8Array): boolean {
  const walked = walk(jpeg)
  if (walked?.end === undefined) return true
  return jpeg.subarray(walked.end).some(byte => byte !== 0)
}
