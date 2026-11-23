// A JPEG is a list of segments: `FF <marker>` and, for most, two bytes of length (that count themselves) and the payload, until the start of the
// scan (`FFDA`), after which comes the image data and the end (`FFD9`). The metadata of a photograph lives in segments of their own: EXIF and
// XMP in `APP1` (where the position, the camera and the time are), the Photoshop and IPTC block in `APP13`, and the free text of a comment in
// `COM`. Cutting those segments out leaves every other byte as it was, so the picture is the same pixels, the same colour space and the same
// size: what a PDF that embeds the file with its `DCTDecode` filter needs, because the image dictionary of the PDF (colour space, width,
// height, decode array) describes the bytes of the JPEG and a new encoding would have to rewrite it. The JPEG of a docx or an xlsx is cleaned
// by the cleaner of pictures instead (`image-sanitizer.ts`), which decodes and encodes it again.
const MARKER_PREFIX = 0xff
const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const APP1 = 0xe1
const APP3 = 0xe3
const APP10 = 0xea
const APP12 = 0xec
const APP13 = 0xed
const COM = 0xfe
const TEM = 0x01
const RST_FIRST = 0xd0
const RST_LAST = 0xd7
const SEGMENT_HEADER_BYTES = 2
const LENGTH_BYTES = 2

const CUT_MARKERS: ReadonlySet<number> = new Set([APP1, APP3, APP10, APP12, APP13, COM])

// Markers that have no length and no payload
const isStandalone = (marker: number): boolean =>
  marker === SOI || marker === EOI || marker === TEM || (marker >= RST_FIRST && marker <= RST_LAST)

// The spans of the segments that carry metadata, as [start, end) offsets, or `undefined` when the bytes are not a JPEG that can be walked from
// its first byte to its scan (a damaged file is left as it is: it is never cut blind)
function metadataSpans(jpeg: Uint8Array): [number, number][] | undefined {
  if (jpeg.length < SEGMENT_HEADER_BYTES || jpeg[0] !== MARKER_PREFIX || jpeg[1] !== SOI) {
    return undefined
  }
  const spans: [number, number][] = []
  let at = SEGMENT_HEADER_BYTES
  while (at < jpeg.length) {
    // Fill bytes (`FF FF`) may precede a marker
    while (at < jpeg.length && jpeg[at] === MARKER_PREFIX && jpeg[at + 1] === MARKER_PREFIX) at += 1
    if (jpeg[at] !== MARKER_PREFIX || at + 1 >= jpeg.length) return undefined
    const marker = jpeg[at + 1] as number
    if (marker === SOS) return spans
    if (isStandalone(marker)) {
      // The end of the image before any scan: nothing to cut after it
      if (marker === EOI) return spans
      at += SEGMENT_HEADER_BYTES
      continue
    }
    if (at + SEGMENT_HEADER_BYTES + LENGTH_BYTES > jpeg.length) return undefined
    const length = ((jpeg[at + 2] as number) << 8) | (jpeg[at + 3] as number)
    const end = at + SEGMENT_HEADER_BYTES + length
    if (length < LENGTH_BYTES || end > jpeg.length) return undefined
    if (CUT_MARKERS.has(marker)) spans.push([at, end])
    at = end
  }
  return undefined
}

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
