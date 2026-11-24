import { cutJpegMetadata, jpegCarriesMetadata } from './jpeg-metadata-cutter'

const segment = (marker: number, payload: number[]): number[] => {
  const length = payload.length + 2
  return [0xff, marker, length >> 8, length & 0xff, ...payload]
}
const ascii = (text: string): number[] => [...Buffer.from(text, 'latin1')]

const SOI = [0xff, 0xd8]
const EOI = [0xff, 0xd9]
const JFIF = segment(0xe0, ascii('JFIF\0'))
const ICC = segment(0xe2, ascii('ICC_PROFILE\0'))
const ADOBE = segment(0xee, ascii('Adobe'))
const FRAME = segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0])
// The scan header, then the entropy data (which may hold `FF 00` and bytes that look like a marker of metadata)
const SCAN = [
  ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
  0x12,
  0xff,
  0x00,
  0xff,
  0xe1,
  0x34,
  0xff,
  0xd0
]
const EXIF = segment(0xe1, ascii('Exif\0\0GPS-secret'))
const XMP = segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'))
const PHOTOSHOP = segment(0xed, ascii('Photoshop 3.0\0IPTC-secret'))
const PICTURE_INFO = segment(0xec, ascii('Ducky secret'))
const KODAK = segment(0xe3, ascii('KODAK secret'))
const COMMENT = segment(0xfe, ascii('shot at the home of Ana'))

const jpeg = (...parts: number[][]): Uint8Array =>
  Uint8Array.from([...SOI, ...parts.flat(), ...EOI])

describe('cutJpegMetadata', () => {
  it('cuts the EXIF, the XMP, the Photoshop block and the comments, and nothing else', () => {
    const dirty = jpeg(
      JFIF,
      EXIF,
      ICC,
      XMP,
      ADOBE,
      PHOTOSHOP,
      COMMENT,
      PICTURE_INFO,
      KODAK,
      FRAME,
      SCAN
    )

    const clean = cutJpegMetadata(dirty)

    expect(clean).toEqual(jpeg(JFIF, ICC, ADOBE, FRAME, SCAN))
    expect(Buffer.from(clean as Uint8Array).includes('secret')).toBe(false)
  })

  it('cuts every application segment that drawing does not need, not only the ones it knew by name', () => {
    // The telemetry of a camera of action (APP6), the manifest of a signer (APP11), and the others a program may write
    const telemetry = segment(0xe6, ascii('GoPro telemetry lat=4.5 lon=-74.08 secret'))
    const manifest = segment(0xeb, ascii('JUMBF c2pa secret'))
    const rest = [0xe4, 0xe5, 0xe7, 0xe8, 0xe9, 0xef].map(marker =>
      segment(marker, ascii('secret position'))
    )
    const multiPicture = segment(0xe2, ascii('MPF\0secret index'))
    const notAdobe = segment(0xee, ascii('Ducky secret'))
    const dirty = jpeg(
      JFIF,
      telemetry,
      ICC,
      manifest,
      ...rest,
      multiPicture,
      notAdobe,
      ADOBE,
      FRAME,
      SCAN
    )

    const clean = cutJpegMetadata(dirty)

    expect(clean).toEqual(jpeg(JFIF, ICC, ADOBE, FRAME, SCAN))
    expect(jpegCarriesMetadata(dirty)).toBe(true)
    expect(jpegCarriesMetadata(clean as Uint8Array)).toBe(false)
  })

  it('knows what it would cut and what it would not', () => {
    expect(jpegCarriesMetadata(jpeg(JFIF, EXIF, FRAME, SCAN))).toBe(true)
    expect(jpegCarriesMetadata(jpeg(JFIF, PHOTOSHOP, FRAME, SCAN))).toBe(true)
    expect(jpegCarriesMetadata(jpeg(JFIF, COMMENT, FRAME, SCAN))).toBe(true)
    expect(jpegCarriesMetadata(jpeg(JFIF, ICC, ADOBE, FRAME, SCAN))).toBe(false)
  })

  it('does not read the image data as segments: a marker inside the scan is not cut', () => {
    // The data after the scan header holds `FF E1 34` on purpose; a walker that did not stop at the scan would cut it
    const clean = jpeg(JFIF, FRAME, SCAN)
    expect(cutJpegMetadata(clean)).toBeUndefined()
    const cut = cutJpegMetadata(jpeg(EXIF, JFIF, FRAME, SCAN)) as Uint8Array
    expect(
      Buffer.from(cut)
        .subarray(cut.length - SCAN.length - 2)
        .toString('hex')
    ).toBe(Buffer.from([...SCAN, ...EOI]).toString('hex'))
  })

  it('walks past the fill bytes that may come before a marker', () => {
    const dirty = Uint8Array.from([...SOI, 0xff, 0xff, ...EXIF, ...JFIF, ...FRAME, ...SCAN, ...EOI])
    // The fill bytes are not a segment: they stay, as every byte that is not metadata
    expect(cutJpegMetadata(dirty)).toEqual(
      Uint8Array.from([...SOI, 0xff, 0xff, ...JFIF, ...FRAME, ...SCAN, ...EOI])
    )
  })

  it('leaves a file it cannot walk as it came: it is never cut blind', () => {
    // Not a JPEG, a segment whose length passes the end, a length that cannot hold itself, a file that stops before its scan
    expect(cutJpegMetadata(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()
    expect(cutJpegMetadata(Uint8Array.from([...SOI, 0xff, 0xe1, 0xff, 0xff, 1, 2]))).toBeUndefined()
    expect(cutJpegMetadata(Uint8Array.from([...SOI, 0xff, 0xe1, 0x00, 0x01, 1, 2]))).toBeUndefined()
    expect(cutJpegMetadata(Uint8Array.from([...SOI, ...EXIF, ...JFIF]))).toBeUndefined()
    expect(cutJpegMetadata(Uint8Array.from([]))).toBeUndefined()
    expect(jpegCarriesMetadata(Uint8Array.from([...SOI, 0xff, 0xe1, 0xff, 0xff]))).toBe(false)
  })
})
