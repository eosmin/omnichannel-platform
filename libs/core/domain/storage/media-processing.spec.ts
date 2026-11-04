import {
  AnimatedImage,
  attachmentDisposition,
  keepsAnimation,
  mediaVariantsSchema
} from './media-processing'

describe('keepsAnimation', () => {
  const webp = 'image/webp'
  // What the header of a sticker says: the bytes are what the row says, with no rotation
  const sticker = { format: 'webp', pages: 30, width: 512, height: 512 }

  it('keeps the animation of a sticker and of a small gif', () => {
    expect(keepsAnimation(webp, sticker)).toBe(true)
    expect(keepsAnimation('image/gif', { format: 'gif', pages: 60, width: 480, height: 270 })).toBe(
      true
    )
  })

  it('does not treat a still image, or one with no frame count, as an animation', () => {
    expect(keepsAnimation(webp, { ...sticker, pages: 1 })).toBe(false)
    expect(keepsAnimation(webp, { ...sticker, pages: undefined })).toBe(false)
  })

  it('refuses to decode more frames than the cap, whatever their size', () => {
    expect(
      keepsAnimation(webp, {
        ...sticker,
        pages: AnimatedImage.MAX_FRAMES + 1,
        width: 16,
        height: 16
      })
    ).toBe(false)
    expect(
      keepsAnimation(webp, { ...sticker, pages: AnimatedImage.MAX_FRAMES, width: 16, height: 16 })
    ).toBe(true)
  })

  it('refuses when the frames together hold more pixels than the budget', () => {
    // 100 frames of 600 x 600 is 36 million pixels: over the budget although each frame is small
    expect(keepsAnimation(webp, { ...sticker, pages: 100, width: 600, height: 600 })).toBe(false)
    expect(keepsAnimation(webp, { ...sticker, pages: 2, width: 20_000, height: 20_000 })).toBe(
      false
    )
    // Right at the budget
    expect(keepsAnimation(webp, { ...sticker, pages: 16, width: 1000, height: 1000 })).toBe(true)
    expect(keepsAnimation(webp, { ...sticker, pages: 16, width: 1000, height: 1001 })).toBe(false)
  })

  it('does not trust a size that is missing or not a whole positive number', () => {
    expect(keepsAnimation(webp, { ...sticker, width: undefined })).toBe(false)
    expect(keepsAnimation(webp, { ...sticker, height: 0 })).toBe(false)
    expect(keepsAnimation(webp, { ...sticker, pages: 10.5 })).toBe(false)
  })

  it('only looks at the formats that can move', () => {
    expect(keepsAnimation('image/png', { ...sticker, format: 'png' })).toBe(false)
    expect(keepsAnimation('image/jpeg', { ...sticker, format: 'jpeg' })).toBe(false)
  })

  it('does not take the word of the row for the bytes: the decoder must find a gif or a webp', () => {
    // A multi-page TIFF or HEIF under a row that says gif or webp has frames of any size
    expect(keepsAnimation(webp, { ...sticker, format: 'tiff' })).toBe(false)
    expect(keepsAnimation('image/gif', { ...sticker, format: 'heif' })).toBe(false)
    expect(keepsAnimation(webp, { ...sticker, format: undefined })).toBe(false)
  })

  it('draws an animation with a quarter-turn orientation still: the frames cannot be rotated', () => {
    expect(keepsAnimation(webp, { ...sticker, orientation: 1 })).toBe(true)
    for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
      expect(keepsAnimation(webp, { ...sticker, orientation })).toBe(false)
    }
  })
})

describe('attachmentDisposition', () => {
  it('quotes a plain name and repeats it encoded', () => {
    expect(attachmentDisposition('photo.png')).toBe(
      `attachment; filename="photo.png"; filename*=UTF-8''photo.png`
    )
  })

  it('cannot be closed or extended by the name', () => {
    const header = attachmentDisposition('a"; inline; x="\r\nSet-Cookie: y=1.html')
    expect(header).not.toMatch(/[\r\n]/)
    expect(header.startsWith('attachment; filename="')).toBe(true)
    // Only the two parameters of the header exist: one quoted, one encoded
    expect(header.match(/"/g)).toHaveLength(2)
  })

  it('keeps a non-ASCII name in the encoded parameter only', () => {
    const header = attachmentDisposition("ñandú (1)'.pdf")
    expect(header).toContain('filename="_and_ (1)\'.pdf"')
    expect(header).toContain("filename*=UTF-8''%C3%B1and%C3%BA%20%281%29%27.pdf")
  })
})

describe('mediaVariantsSchema', () => {
  it('accepts keys and a missing variant', () => {
    expect(mediaVariantsSchema.parse({ full: 'a', thumb: 'b' })).toEqual({ full: 'a', thumb: 'b' })
  })

  it('drops a value that is not a key and keeps the others', () => {
    expect(mediaVariantsSchema.parse({ full: 3, thumb: 'b' })).toEqual({ thumb: 'b' })
  })

  it('refuses what is not an object', () => {
    expect(mediaVariantsSchema.safeParse('x').success).toBe(false)
  })
})
