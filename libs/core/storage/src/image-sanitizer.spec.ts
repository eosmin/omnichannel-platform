import sharp from 'sharp'

import { ImageSanitizing } from '@platform/core/storage'

import { ImageNotSanitizable, isSanitizedType, sanitizeImage } from './image-sanitizer'

// A 20x10 picture: red on the left half, blue on the right half
async function twoColours(): Promise<ReturnType<typeof sharp>> {
  const left = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } }
  })
    .png()
    .toBuffer()
  return sharp({
    create: { width: 20, height: 10, channels: 3, background: { r: 0, g: 0, b: 255 } }
  }).composite([{ input: left, left: 0, top: 0 }])
}

// What a phone writes: where, with what, when, and how the camera was held
const PHONE_EXIF = {
  IFD0: { Make: 'Acme', Model: 'Phone 1' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '4/1 30/1 0/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '74/1 5/1 0/1'
  }
}

async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
  const at = (y * info.width + x) * info.channels
  return [data[at] ?? -1, data[at + 1] ?? -1, data[at + 2] ?? -1]
}

describe('sanitizeImage', () => {
  it('takes the location and the camera out of a jpeg and keeps it upright', async () => {
    const photo = await (
      await twoColours()
    )
      .withMetadata({ orientation: 6, exif: PHONE_EXIF })
      .jpeg({ quality: 100 })
      .toBuffer()
    const before = await sharp(photo).metadata()
    expect(before.exif).toBeDefined() // The fixture does carry the metadata
    expect(before.orientation).toBe(6)

    const result = await sanitizeImage(photo, 'image/jpeg')

    if (result.kind !== 'sanitized') throw new Error('expected a sanitized picture')
    const after = await sharp(result.body).metadata()
    expect(after.format).toBe('jpeg')
    expect(after.exif).toBeUndefined()
    expect(after.orientation).toBeUndefined()
    expect(result.body.includes('Exif')).toBe(false)
    expect(result.body.includes('Acme')).toBe(false)
    // Orientation 6 is a quarter turn clockwise: the left (red) half ends at the top of a 10x20 picture
    expect([after.width, after.height]).toEqual([10, 20])
    const top = await pixel(result.body, 5, 2)
    const bottom = await pixel(result.body, 5, 17)
    expect(top[0]).toBeGreaterThan(200)
    expect(top[2]).toBeLessThan(60)
    expect(bottom[2]).toBeGreaterThan(200)
    expect(bottom[0]).toBeLessThan(60)
  })

  it('takes the metadata out of a webp', async () => {
    const photo = await (
      await twoColours()
    )
      .withMetadata({ orientation: 6, exif: PHONE_EXIF })
      .webp()
      .toBuffer()
    expect((await sharp(photo).metadata()).exif).toBeDefined()
    expect((await sharp(photo).metadata()).orientation).toBe(6)

    const result = await sanitizeImage(photo, 'image/webp')

    if (result.kind !== 'sanitized') throw new Error('expected a sanitized picture')
    const after = await sharp(result.body).metadata()
    expect(after.format).toBe('webp')
    expect(after.exif).toBeUndefined()
    expect([after.width, after.height]).toEqual([10, 20])
  })

  it('takes the metadata out of a png', async () => {
    const photo = await (
      await twoColours()
    )
      .withMetadata({ orientation: 6, exif: PHONE_EXIF })
      .png()
      .toBuffer()
    expect((await sharp(photo).metadata()).exif).toBeDefined()
    expect((await sharp(photo).metadata()).orientation).toBe(6)

    const result = await sanitizeImage(photo, 'image/png')

    if (result.kind !== 'sanitized') throw new Error('expected a sanitized picture')
    const after = await sharp(result.body).metadata()
    expect(after.format).toBe('png')
    expect(after.exif).toBeUndefined()
    expect([after.width, after.height]).toEqual([10, 20])
  })

  it('keeps the colour profile', async () => {
    const photo = await (await twoColours()).withIccProfile('p3').jpeg().toBuffer()
    expect((await sharp(photo).metadata()).icc).toBeDefined()

    const result = await sanitizeImage(photo, 'image/jpeg')

    if (result.kind !== 'sanitized') throw new Error('expected a sanitized picture')
    expect((await sharp(result.body).metadata()).icc).toBeDefined()
  })

  it('leaves an animated webp and a gif exactly as they came', async () => {
    const frames = sharp(
      Buffer.concat([
        await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
          .raw()
          .toBuffer(),
        await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } })
          .raw()
          .toBuffer()
      ]),
      { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } }
    )
    const animatedWebp = await frames.clone().webp().toBuffer()
    const animatedGif = await frames.clone().gif().toBuffer()
    expect((await sharp(animatedWebp, { animated: true }).metadata()).pages).toBe(2)

    const webp = await sanitizeImage(animatedWebp, 'image/webp')
    const gif = await sanitizeImage(animatedGif, 'image/gif')

    expect(webp).toEqual({ kind: 'untouched', why: 'animated' })
    expect(gif).toEqual({ kind: 'untouched', why: 'type' })
  })

  it('leaves an animated png alone', async () => {
    const still = await (await twoColours()).png().toBuffer()
    // An `acTL` chunk before the data is what makes a png animated
    const at = still.indexOf('IDAT') - 4
    const animated = Buffer.concat([
      still.subarray(0, at),
      Buffer.from([0, 0, 0, 8]),
      Buffer.from('acTL'),
      Buffer.alloc(8),
      Buffer.alloc(4),
      still.subarray(at)
    ])

    expect(await sanitizeImage(animated, 'image/png')).toEqual({
      kind: 'untouched',
      why: 'animated'
    })
  })

  it('refuses a file that is not what it says', async () => {
    const page = Buffer.from('<html><script>alert(1)</script></html>')
    const png = await (await twoColours()).png().toBuffer()

    await expect(sanitizeImage(page, 'image/png')).rejects.toBeInstanceOf(ImageNotSanitizable)
    // A png declared as a jpeg: the signature does not match
    await expect(sanitizeImage(png, 'image/jpeg')).rejects.toBeInstanceOf(ImageNotSanitizable)
  })

  it('refuses a corrupt picture and never returns it with its metadata', async () => {
    const photo = await (
      await twoColours()
    )
      .withMetadata({ orientation: 6, exif: PHONE_EXIF })
      .jpeg()
      .toBuffer()
    const broken = Buffer.concat([photo.subarray(0, 40), Buffer.alloc(200, 0x41)])

    await expect(sanitizeImage(broken, 'image/jpeg')).rejects.toBeInstanceOf(ImageNotSanitizable)
  })

  it('refuses a picture with more pixels than the limit, before decoding it', async () => {
    // A 1-colour png of 12000x12000 (144 million pixels) is a few KB: a decompression bomb
    const bomb = await sharp({
      create: { width: 12000, height: 12000, channels: 3, background: '#000' }
    })
      .png({ compressionLevel: 9 })
      .toBuffer()
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024)

    await expect(sanitizeImage(bomb, 'image/png')).rejects.toBeInstanceOf(ImageNotSanitizable)
  }, 60_000)

  it('does not take a static png for an animation because a text chunk holds the letters acTL', async () => {
    const still = await (
      await twoColours()
    )
      .withMetadata({ orientation: 6, exif: PHONE_EXIF })
      .png()
      .toBuffer()
    // A tEXt chunk before the data: keyword, a NUL, and the text. Its CRC is not checked by the decoder.
    const text = Buffer.from('Comment\0acTL')
    const chunk = Buffer.concat([
      Buffer.from([0, 0, 0, text.length]),
      Buffer.from('tEXt'),
      text,
      Buffer.alloc(4)
    ])
    const at = still.indexOf('IDAT') - 4
    const sneaky = Buffer.concat([still.subarray(0, at), chunk, still.subarray(at)])
    expect(sneaky.indexOf('acTL')).toBeLessThan(sneaky.indexOf('IDAT'))

    const result = await sanitizeImage(sneaky, 'image/png')

    if (result.kind !== 'sanitized') throw new Error('expected a sanitized picture')
    expect((await sharp(result.body).metadata()).exif).toBeUndefined()
  })

  it('lowers the quality until the cleaned picture fits the file limit, and refuses one that cannot', async () => {
    const noise = Buffer.alloc(400 * 300 * 3)
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 7919 + (i >> 3) * 104729) % 256
    const photo = await sharp(noise, { raw: { width: 400, height: 300, channels: 3 } })
      .jpeg({ quality: 60 })
      .toBuffer()
    const at = async (quality: number): Promise<number> =>
      (await sharp(photo).jpeg({ quality }).toBuffer()).length
    const [high, low] = [
      await at(ImageSanitizing.QUALITIES[0]),
      await at(ImageSanitizing.QUALITIES[2])
    ]
    expect(low).toBeLessThan(high)

    const fits = await sanitizeImage(photo, 'image/jpeg', Math.floor((high + low) / 2))
    if (fits.kind !== 'sanitized') throw new Error('expected a sanitized picture')
    expect(fits.body.length).toBeLessThanOrEqual(Math.floor((high + low) / 2))

    await expect(sanitizeImage(photo, 'image/jpeg', 100)).rejects.toBeInstanceOf(
      ImageNotSanitizable
    )
  })

  it('refuses a picture over the pixels it may have to be cleaned, though it is under the variants cap', async () => {
    const big = await sharp({
      create: { width: 8000, height: 8000, channels: 3, background: '#000' }
    })
      .png({ compressionLevel: 9 })
      .toBuffer()
    expect(8000 * 8000).toBeGreaterThan(ImageSanitizing.MAX_INPUT_PIXELS)

    await expect(sanitizeImage(big, 'image/png')).rejects.toBeInstanceOf(ImageNotSanitizable)
  }, 60_000)

  it('says which types it cleans, and they are those it has a format for', () => {
    expect(ImageSanitizing.CONTENT_TYPES.every(isSanitizedType)).toBe(true)
    expect(isSanitizedType('image/gif')).toBe(false)
    expect(isSanitizedType('application/pdf')).toBe(false)
  })
})
