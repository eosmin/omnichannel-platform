import { crc32 } from 'node:zlib'

import sharp from 'sharp'

import { cleanGif, cleanPng, cleanWebp, pngChunkTypes } from './animated-image-cleaner'
import { carriesMetadata, ImageNotSanitizable, sanitizeImage } from './image-sanitizer'

const AUTHOR = 'Jane Q. Author'
const PROGRAM = 'Acme Animator 9'

// Two frames, red then blue, 8x8 each; the delay and the loop are set so that the cleaning can be seen to keep them
async function frames(): Promise<ReturnType<typeof sharp>> {
  const red = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
    .raw()
    .toBuffer()
  const blue = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } })
    .raw()
    .toBuffer()
  return sharp(Buffer.concat([red, blue]), {
    raw: { width: 8, height: 16, channels: 3, pageHeight: 8 }
  })
}

const gctBytes = (gif: Buffer): number =>
  ((gif[10] as number) & 0x80) === 0 ? 0 : 3 * 2 ** (((gif[10] as number) & 0x07) + 1)

const gifSubBlocks = (data: Buffer): Buffer => {
  const parts: Buffer[] = []
  for (let at = 0; at < data.length; at += 255) {
    const piece = data.subarray(at, at + 255)
    parts.push(Buffer.from([piece.length]), piece)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

// A gif with a comment and an XMP block (author, program) put in front of its first frame
async function gifWithMetadata(): Promise<Buffer> {
  const gif = await (await frames()).gif({ delay: [120, 120], loop: 3 }).toBuffer()
  const flags = gif[10] as number
  const gct = (flags & 0x80) === 0 ? 0 : 3 * 2 ** ((flags & 0x07) + 1)
  const at = 13 + gct
  const comment = Buffer.concat([
    Buffer.from([0x21, 0xfe]),
    gifSubBlocks(Buffer.from(`by ${AUTHOR}`))
  ])
  const xmp = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('XMP DataXMP'),
    gifSubBlocks(
      Buffer.from(
        `<x:xmpmeta><dc:creator>${AUTHOR}</dc:creator><xmp:CreatorTool>${PROGRAM}</xmp:CreatorTool></x:xmpmeta>`
      )
    )
  ])
  return Buffer.concat([gif.subarray(0, at), comment, xmp, gif.subarray(at)])
}

// An animated WebP with an EXIF chunk and an XMP chunk, announced in the flags of its extended header
async function webpWithMetadata(): Promise<Buffer> {
  const webp = await (await frames()).webp({ delay: [120, 120], loop: 3 }).toBuffer()
  const chunk = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8)
    header.write(type, 0, 'latin1')
    header.writeUInt32LE(payload.length, 4)
    return Buffer.concat([
      header,
      payload,
      payload.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
    ])
  }
  const exif = chunk('EXIF', Buffer.from(`II*\0Make ${AUTHOR}`))
  const xmp = chunk('XMP ', Buffer.from(`<x:xmpmeta>${PROGRAM}</x:xmpmeta>`))
  const body = Buffer.concat([webp.subarray(12), exif, xmp])
  const out = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), body])
  out.writeUInt32LE(out.length - 8, 4)
  expect(out.toString('latin1', 12, 16)).toBe('VP8X')
  out[20] = (out[20] as number) | 0x08 | 0x04
  return out
}

const pngChunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}

// A png with an `acTL` chunk (so it is an animation) and text, EXIF and time chunks around its data
async function apngWithMetadata(): Promise<Buffer> {
  const still = await (await frames()).png().toBuffer()
  const at = still.indexOf('IDAT') - 4
  return Buffer.concat([
    still.subarray(0, at),
    pngChunk('acTL', Buffer.alloc(8)),
    pngChunk('tEXt', Buffer.from(`Author\0${AUTHOR}`)),
    pngChunk('eXIf', Buffer.from(`II*\0${AUTHOR}`)),
    pngChunk('tIME', Buffer.alloc(7)),
    still.subarray(at)
  ])
}

describe('a gif', () => {
  it('loses its comment and XMP block and keeps every frame, delay and the loop', async () => {
    const dirty = await gifWithMetadata()
    expect(dirty.includes(AUTHOR)).toBe(true)

    const clean = cleanGif(dirty)

    expect(clean.includes(AUTHOR)).toBe(false)
    expect(clean.includes(PROGRAM)).toBe(false)
    expect(clean.includes('XMP DataXMP')).toBe(false)
    const was = await sharp(dirty, { animated: true }).metadata()
    const is = await sharp(clean, { animated: true }).metadata()
    expect(is.pages).toBe(2)
    expect(is.loop).toBe(was.loop)
    expect(is.delay).toEqual(was.delay)
    expect([is.width, is.pageHeight]).toEqual([was.width, was.pageHeight])
    // The picture itself is the same: the pixels of both frames
    const pixels = async (gif: Buffer): Promise<Buffer> =>
      sharp(gif, { animated: true }).raw().toBuffer()
    expect((await pixels(clean)).equals(await pixels(dirty))).toBe(true)
  })

  it('keeps the loop count block when it is spelled as the program that wrote it', async () => {
    const clean = cleanGif(await gifWithMetadata())
    expect(clean.includes('NETSCAPE2.0')).toBe(true)
  })

  it('is the same bytes when there is nothing to cut', async () => {
    const plain = cleanGif(await gifWithMetadata())
    expect(cleanGif(plain).equals(plain)).toBe(true)
  })

  it('plays what the viewers play: zero padding between blocks, no trailer, an odd application block, and keeps the colour profile', async () => {
    const dirty = await gifWithMetadata()
    const trailer = dirty.length - 1
    expect(dirty[trailer]).toBe(0x3b)
    // Padding after the header block, no trailer at the end
    const padded = Buffer.concat([
      dirty.subarray(0, 13 + gctBytes(dirty)),
      Buffer.from([0, 0]),
      dirty.subarray(13 + gctBytes(dirty), trailer)
    ])
    const clean = cleanGif(padded)
    expect(clean.includes(AUTHOR)).toBe(false)
    expect(clean.at(-1)).toBe(0x3b)
    expect((await sharp(clean, { animated: true }).metadata()).pages).toBe(2)

    const odd = Buffer.concat([
      Buffer.from([0x21, 0xff, 0x03]),
      Buffer.from('abc'),
      Buffer.from([1, 9, 0])
    ])
    const icc = Buffer.concat([
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from('ICCRGBG1012'),
      Buffer.from([2, 1, 2, 0])
    ])
    const at = 13 + gctBytes(dirty)
    const withBlocks = Buffer.concat([dirty.subarray(0, at), odd, icc, dirty.subarray(at)])
    const cleaned = cleanGif(withBlocks)
    expect(cleaned.includes('ICCRGBG1012')).toBe(true)
    expect(cleaned.includes('abc')).toBe(false)
  })

  it('refuses a gif that is cut short or has an unknown block', async () => {
    const dirty = await gifWithMetadata()
    expect(() => cleanGif(dirty.subarray(0, dirty.length - 20))).toThrow()
    expect(() => cleanGif(Buffer.from('GIF89a'))).toThrow()
  })
})

describe('an animated webp', () => {
  it('loses its EXIF and XMP chunks, the flags that announce them and keeps its frames', async () => {
    const dirty = await webpWithMetadata()

    const clean = cleanWebp(dirty)

    expect(clean.includes(AUTHOR)).toBe(false)
    expect(clean.includes(PROGRAM)).toBe(false)
    expect(clean.readUInt32LE(4)).toBe(clean.length - 8)
    expect((clean[20] as number) & 0x0c).toBe(0)
    const is = await sharp(clean, { animated: true }).metadata()
    expect(is.pages).toBe(2)
    expect(is.exif).toBeUndefined()
    expect(is.xmp).toBeUndefined()
    const pixels = async (webp: Buffer): Promise<Buffer> =>
      sharp(webp, { animated: true }).raw().toBuffer()
    expect((await pixels(clean)).equals(await pixels(await webpWithoutChunks()))).toBe(true)
  })

  it('refuses a chunk that runs past the end of the file', async () => {
    const dirty = await webpWithMetadata()
    expect(() => cleanWebp(dirty.subarray(0, dirty.length - 30))).toThrow()
  })

  it('refuses bytes that are not a riff webp', () => {
    expect(() => cleanWebp(Buffer.from('not a webp at all, not even close'))).toThrow()
  })
})

async function webpWithoutChunks(): Promise<Buffer> {
  return (await frames()).webp({ delay: [120, 120], loop: 3 }).toBuffer()
}

describe('an animated png', () => {
  it('loses its text, EXIF and time chunks and keeps the others in order', async () => {
    const dirty = await apngWithMetadata()
    expect(dirty.includes(AUTHOR)).toBe(true)

    const clean = cleanPng(dirty)

    expect(clean.includes(AUTHOR)).toBe(false)
    const types = pngChunkTypes(clean)
    expect(types).toEqual(pngChunkTypes(dirty).filter(t => !['tEXt', 'eXIf', 'tIME'].includes(t)))
    expect(types).toContain('acTL')
    expect(types.at(-1)).toBe('IEND')
  })
})

describe('a png that is cut short', () => {
  it('is refused: it has no IEND', async () => {
    const dirty = await apngWithMetadata()
    expect(() => cleanPng(dirty.subarray(0, dirty.length - 12))).toThrow()
  })
})

describe('sanitizeImage with an animation', () => {
  it('cleans a gif and checks that it still has its two frames', async () => {
    const dirty = await gifWithMetadata()

    const result = await sanitizeImage(dirty, 'image/gif')

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    expect(result.body.includes(AUTHOR)).toBe(false)
    expect(result.body.length).toBeLessThan(dirty.length)
    expect((await sharp(result.body, { animated: true }).metadata()).pages).toBe(2)
  })

  it('cleans an animated webp and an animated png', async () => {
    const webp = await sanitizeImage(await webpWithMetadata(), 'image/webp')
    const png = await sanitizeImage(await apngWithMetadata(), 'image/png')

    expect(webp.kind).toBe('sanitized')
    expect(png.kind).toBe('sanitized')
    if (webp.kind === 'sanitized') expect(webp.body.includes(AUTHOR)).toBe(false)
    if (png.kind === 'sanitized') expect(png.body.includes(AUTHOR)).toBe(false)
  })

  it('says untouched for an animation that carries nothing', async () => {
    const plain = await webpWithoutChunks()
    expect(await sanitizeImage(plain, 'image/webp')).toEqual({ kind: 'untouched', why: 'animated' })
  })

  it('refuses a gif it cannot walk, and never lets one through', async () => {
    const dirty = await gifWithMetadata()
    await expect(
      sanitizeImage(dirty.subarray(0, dirty.length - 30), 'image/gif')
    ).rejects.toBeInstanceOf(ImageNotSanitizable)
  })

  it('carriesMetadata sees what the cleaning would cut in an animation and nothing once it is cut', async () => {
    const dirty = await gifWithMetadata()
    expect(await carriesMetadata(dirty)).toBe(true)
    expect(await carriesMetadata(cleanGif(dirty))).toBe(false)
    expect(await carriesMetadata(await webpWithMetadata())).toBe(true)
    expect(await carriesMetadata(cleanWebp(await webpWithMetadata()))).toBe(false)
    expect(await carriesMetadata(await apngWithMetadata())).toBe(true)
    expect(await carriesMetadata(cleanPng(await apngWithMetadata()))).toBe(false)
  })
})
