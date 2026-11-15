import sharp from 'sharp'

import { PluginIconLimits } from '@platform/core/domain'

// The icon a plugin author hosts is never served: the platform decodes it and keeps its own 128 by 128 PNG (TDD_10
// §6.7.2). Decoding an SVG rasterises it, so no script or reference of it can ever run in a browser; the markup that could
// make the rasteriser read a file or a host is refused before it gets there.

export class PluginIconRefused extends Error {
  constructor(reason: string) {
    super(`the icon of the plugin is not accepted: ${reason}`)
    this.name = 'PluginIconRefused'
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const SVG_DENSITY = 384

type IconFormat = 'png' | 'jpeg' | 'svg'

// Markup that reaches outside the picture or runs: a script, an embedded document, an entity, a stylesheet import,
// and any reference that is not to another part of the same picture (`#id`)
const UNSAFE_SVG: readonly RegExp[] = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /<\s*iframe/i,
  /<\s*embed/i,
  /<\s*object/i,
  /<!\s*ENTITY/i,
  /<!\s*DOCTYPE(?:(?!<svg)[\s\S])*\[/i,
  /<\?\s*xml-stylesheet/i,
  /@import/i,
  /<[^>]*[\s"']on[a-z]+\s*=/i,
  /(?:xlink:)?href\s*=\s*["'](?!#)/i,
  /url\(\s*["']?\s*[^\s#"')]/i
]

// The format the bytes show, never the one the server or the extension claims
function formatOf(bytes: Buffer): IconFormat | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png'
  if (bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'jpeg'
  const head = bytes
    .subarray(0, 1024)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
  // A prolog (declaration, comments, a doctype with or without an internal subset) and then the root element. What the
  // prolog may hold is judged by UNSAFE_SVG, not here.
  if (/^(?:<\?xml|<!|<svg[\s>])/i.test(head) && /<svg[\s>]/i.test(head)) return 'svg'
  return null
}

// The 128 by 128 PNG of the picture, or `PluginIconRefused`
export async function renderPluginIcon(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > PluginIconLimits.MAX_BYTES) {
    throw new PluginIconRefused('empty or too big')
  }
  const format = formatOf(bytes)
  if (format === null) throw new PluginIconRefused('not a PNG, JPEG or SVG')
  if (format === 'svg') {
    const text = bytes.toString('utf8')
    if (UNSAFE_SVG.some(pattern => pattern.test(text))) {
      throw new PluginIconRefused('the SVG reaches outside the picture')
    }
  }
  try {
    const source = sharp(bytes, {
      limitInputPixels: PluginIconLimits.MAX_INPUT_PIXELS,
      failOn: 'error',
      ...(format === 'svg' ? { density: SVG_DENSITY } : {})
    })
    const header = await source.metadata()
    if (header.format !== format) {
      throw new PluginIconRefused('the decoder found another format')
    }
    // Metadata is dropped by default: only the pixels are kept
    return await source
      .rotate()
      .resize(PluginIconLimits.SIZE_PX, PluginIconLimits.SIZE_PX, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png({ compressionLevel: 9 })
      .toBuffer()
  } catch (error) {
    if (error instanceof PluginIconRefused) throw error
    throw new PluginIconRefused('it cannot be decoded')
  }
}
