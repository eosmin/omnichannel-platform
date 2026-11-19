import sharp from 'sharp'

import { PluginIconLimits } from '@platform/core/domain'

import { PluginIconRefused, renderPluginIcon } from './plugin-icon'

// The first call of sharp in a process loads its native library, and on a slow runner that took more than the 5 s
// of a case (the first case failed alone, the rest passed). Every case here decodes or draws pictures, so the
// limit is raised for the file; what each case asserts is unchanged.
jest.setTimeout(30_000)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const picture = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })

const svg = (body: string, attributes = '') =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" ${attributes}>${body}</svg>`
  )

const refusalOf = async (bytes: Buffer): Promise<string> => {
  try {
    await renderPluginIcon(bytes)
  } catch (error) {
    expect(error).toBeInstanceOf(PluginIconRefused)
    return (error as Error).message
  }
  throw new Error('the icon was accepted')
}

describe('renderPluginIcon', () => {
  it('makes a 128 by 128 PNG of a PNG of another size', async () => {
    const out = await renderPluginIcon(await picture(40, 40).png().toBuffer())
    expect(out.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    const meta = await sharp(out).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 128, 128])
  })

  it('keeps the proportions of a picture that is not square, on a transparent background', async () => {
    const out = await renderPluginIcon(await picture(100, 50).png().toBuffer())
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([128, 128])
    // The first pixel is outside the picture: fully transparent
    expect(data[3]).toBe(0)
  })

  it('accepts a JPEG', async () => {
    const out = await renderPluginIcon(await picture(60, 60).jpeg().toBuffer())
    expect((await sharp(out).metadata()).format).toBe('png')
  })

  it('rasterises an SVG', async () => {
    const out = await renderPluginIcon(svg('<rect width="64" height="64" fill="#336699"/>'))
    const meta = await sharp(out).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 128, 128])
  })

  it('keeps no metadata of the original', async () => {
    const original = await picture(40, 40)
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-author' } } })
      .png()
      .toBuffer()
    const out = await renderPluginIcon(original)
    const meta = await sharp(out).metadata()
    expect(meta.exif).toBeUndefined()
    expect(out.includes(Buffer.from('secret-author'))).toBe(false)
  })

  it('judges the bytes, not what the file claims to be', async () => {
    expect(await refusalOf(Buffer.from('<html><body>hello</body></html>'))).toContain('not a PNG')
    expect(await refusalOf(Buffer.from('GIF89a......'))).toContain('not a PNG')
    // The signature of a PNG on bytes that are not one
    expect(await refusalOf(Buffer.concat([PNG_SIGNATURE, Buffer.from('not a picture')]))).toContain(
      'cannot be decoded'
    )
  })

  it('refuses an empty file and one past the size limit', async () => {
    expect(await refusalOf(Buffer.alloc(0))).toContain('empty or too big')
    const big = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(PluginIconLimits.MAX_BYTES)])
    expect(await refusalOf(big)).toContain('empty or too big')
  })

  it('refuses a picture with more pixels than the limit, before decoding it whole', async () => {
    // Under the size limit, and 9 megapixels
    const bomb = await picture(3000, 3000).png({ compressionLevel: 9 }).toBuffer()
    expect(bomb.length).toBeLessThan(PluginIconLimits.MAX_BYTES)
    expect(await refusalOf(bomb)).toContain('cannot be decoded')
  })

  describe('an SVG that reaches outside the picture', () => {
    it.each([
      ['a script', '<script>alert(1)</script><rect width="1" height="1"/>'],
      ['a handler', '<rect width="1" height="1" onload="alert(1)"/>'],
      ['a foreign object', '<foreignObject width="10" height="10"><div/></foreignObject>'],
      [
        'an image of another host',
        '<image href="https://evil.example/x.png" width="10" height="10"/>'
      ],
      ['an image through xlink', '<image xlink:href="file:///etc/passwd" width="10" height="10"/>'],
      ['a use of another document', '<use href="other.svg#a"/>'],
      ['a stylesheet import', '<style>@import url(https://evil.example/a.css);</style>'],
      [
        'a url() of another host',
        '<rect width="1" height="1" style="fill:url(https://evil.example/a)"/>'
      ],
      ['a data uri', '<image href="data:image/png;base64,AAAA" width="1" height="1"/>']
    ])('refuses %s', async (_name, body) => {
      expect(await refusalOf(svg(body))).toContain('reaches outside')
    })

    it('refuses an entity and a doctype with an internal subset', async () => {
      const entity = Buffer.from(
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><text>&x;</text></svg>'
      )
      expect(await refusalOf(entity)).toContain('reaches outside')
    })

    it('accepts a local reference written with spaces or quotes, and text that looks like a handler', async () => {
      const out = await renderPluginIcon(
        svg(
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="64" height="64" fill="url( #g)"/><rect width="8" height="8" fill="url(\'#g\')"/><text x="1" y="9">one = 1</text>'
        )
      )
      expect((await sharp(out).metadata()).width).toBe(128)
    })

    it('accepts a reference to a part of the same picture', async () => {
      const out = await renderPluginIcon(
        svg(
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/>'
        )
      )
      expect((await sharp(out).metadata()).width).toBe(128)
    })
  })
})
