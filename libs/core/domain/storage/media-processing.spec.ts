import { attachmentDisposition, mediaVariantsSchema } from './media-processing'

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
