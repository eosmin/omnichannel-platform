import { AnimatedImageCleaning } from '@platform/core/storage'

// A gif, an animated WebP or an animated PNG that cannot be walked as the format says: it is refused like a picture that cannot be
// decoded (the caller turns it into `ImageNotSanitizable`), because the original, with whatever it carries, is never kept.
export class AnimatedImageMalformed extends Error {
  constructor(readonly why: string) {
    super('the animation cannot be walked')
  }
}

const fail = (why: string): never => {
  throw new AnimatedImageMalformed(why)
}

// ---- GIF -------------------------------------------------------------------------------------------------------------------------
// Walks the blocks of the file and writes back every one but the comment, the plain text and the application extensions that are not the
// loop count (XMP lives in one). No pixel is decoded or encoded: the frames, the delays and the loop are the same bytes.

const GIF_HEADER_BYTES = 6
const GIF_SCREEN_DESCRIPTOR_BYTES = 7
const GIF_EXTENSION = 0x21
const GIF_IMAGE = 0x2c
const GIF_TRAILER = 0x3b
const GIF_COMMENT = 0xfe
const GIF_PLAIN_TEXT = 0x01
const GIF_APPLICATION = 0xff
const GIF_IMAGE_DESCRIPTOR_BYTES = 9

function gifColorTableBytes(flags: number): number {
  return (flags & 0x80) === 0 ? 0 : 3 * 2 ** ((flags & 0x07) + 1)
}

// The end (exclusive) of a run of sub-blocks that starts at `at` (a size byte, its data, ... and a zero size)
function endOfSubBlocks(input: Buffer, at: number): number {
  let cursor = at
  for (;;) {
    if (cursor >= input.length) return fail('gif sub-block runs past the end')
    const size = input[cursor] as number
    cursor += 1
    if (size === 0) return cursor
    cursor += size
  }
}

export function cleanGif(input: Buffer): Buffer {
  if (input.length < GIF_HEADER_BYTES + GIF_SCREEN_DESCRIPTOR_BYTES) return fail('gif too short')
  const out: Buffer[] = []
  let cursor = GIF_HEADER_BYTES + GIF_SCREEN_DESCRIPTOR_BYTES
  cursor += gifColorTableBytes(input[GIF_HEADER_BYTES + 4] as number)
  out.push(input.subarray(0, cursor))
  let frames = 0
  for (;;) {
    // A gif that ends without its trailer plays in every browser: it is closed here, when it has a frame
    if (cursor >= input.length) {
      if (frames === 0) return fail('gif has no frame')
      out.push(Buffer.from([GIF_TRAILER]))
      break
    }
    const introducer = input[cursor] as number
    if (introducer === GIF_TRAILER) {
      out.push(Buffer.from([GIF_TRAILER]))
      break
    }
    // Some encoders pad with zero bytes between blocks; viewers skip them, and so does this walk (the padding is not copied)
    if (introducer === 0) {
      cursor += 1
      continue
    }
    if (introducer === GIF_EXTENSION) {
      const label = input[cursor + 1]
      if (label === undefined) return fail('gif extension has no label')
      const end = endOfSubBlocks(input, cursor + 2)
      let keep = true
      if (label === GIF_APPLICATION) {
        // The first sub-block is the identifier and its code (11 bytes): any other size is not a block that is known, so it goes
        const size = input[cursor + 2]
        const id = input.toString('latin1', cursor + 3, cursor + 3 + (size ?? 0))
        keep =
          size === AnimatedImageCleaning.GIF_APPLICATION_ID_BYTES &&
          AnimatedImageCleaning.GIF_KEPT_APPLICATIONS.some(kept => kept === id)
      } else if (label === GIF_COMMENT || label === GIF_PLAIN_TEXT) {
        // The comment and the plain text extension (almost no viewer draws it) hold free text: they go
        keep = false
      }
      if (keep) out.push(input.subarray(cursor, end))
      cursor = end
      continue
    }
    if (introducer === GIF_IMAGE) {
      const flagsAt = cursor + 1 + GIF_IMAGE_DESCRIPTOR_BYTES - 1
      const flags = input[flagsAt]
      if (flags === undefined) return fail('gif image descriptor is cut')
      // After the descriptor and its local colour table: the LZW minimum code size, then the data sub-blocks
      const dataAt = flagsAt + 1 + gifColorTableBytes(flags) + 1
      const end = endOfSubBlocks(input, dataAt)
      out.push(input.subarray(cursor, end))
      frames += 1
      cursor = end
      continue
    }
    return fail('gif has an unknown block')
  }
  if (frames === 0) return fail('gif has no frame')
  return Buffer.concat(out)
}

// ---- WebP ------------------------------------------------------------------------------------------------------------------------
// RIFF: the EXIF and XMP chunks are dropped, the flags that announce them are cleared and the size of the file is written again.

const RIFF_HEADER_BYTES = 12
const RIFF_CHUNK_HEADER_BYTES = 8
const WEBP_EXTENDED = 'VP8X'

export function cleanWebp(input: Buffer): Buffer {
  if (
    input.length < RIFF_HEADER_BYTES ||
    input.toString('latin1', 0, 4) !== 'RIFF' ||
    input.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return fail('not a riff webp')
  }
  const chunks: Buffer[] = []
  let cursor = RIFF_HEADER_BYTES
  while (cursor + RIFF_CHUNK_HEADER_BYTES <= input.length) {
    const type = input.toString('latin1', cursor, cursor + 4)
    const size = input.readUInt32LE(cursor + 4)
    // A chunk is padded to an even length; the last chunk may come without its pad byte
    const end = Math.min(cursor + RIFF_CHUNK_HEADER_BYTES + size + (size % 2), input.length)
    if (cursor + RIFF_CHUNK_HEADER_BYTES + size > input.length)
      return fail('webp chunk runs past the end')
    if (!AnimatedImageCleaning.WEBP_DROPPED_CHUNKS.some(dropped => dropped === type)) {
      const chunk = Buffer.from(input.subarray(cursor, end))
      if (type === WEBP_EXTENDED && size >= 1) {
        const dropFlags = AnimatedImageCleaning.WEBP_FLAG_EXIF | AnimatedImageCleaning.WEBP_FLAG_XMP
        chunk[RIFF_CHUNK_HEADER_BYTES] =
          (chunk[RIFF_CHUNK_HEADER_BYTES] as number) & ~dropFlags & 0xff
      }
      chunks.push(chunk)
    }
    cursor = end
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(RIFF_HEADER_BYTES)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WEBP', 8, 'latin1')
  return Buffer.concat([header, body])
}

// ---- PNG -------------------------------------------------------------------------------------------------------------------------
// The text, EXIF and time chunks are dropped; every other chunk, with its own CRC, is copied as it is, so the animation chunks stay.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CHUNK_OVERHEAD_BYTES = 12 // Length, type and CRC

export function cleanPng(input: Buffer): Buffer {
  if (input.length < PNG_SIGNATURE.length || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return fail('not a png')
  }
  const out: Buffer[] = [PNG_SIGNATURE]
  let cursor = PNG_SIGNATURE.length
  for (;;) {
    if (cursor + PNG_CHUNK_OVERHEAD_BYTES > input.length) return fail('png has no IEND')
    const length = input.readUInt32BE(cursor)
    const type = input.toString('latin1', cursor + 4, cursor + 8)
    const end = cursor + PNG_CHUNK_OVERHEAD_BYTES + length
    if (end > input.length) return fail('png chunk runs past the end')
    if (!AnimatedImageCleaning.PNG_DROPPED_CHUNKS.some(dropped => dropped === type)) {
      out.push(input.subarray(cursor, end))
    }
    cursor = end
    if (type === 'IEND') break
  }
  return Buffer.concat(out)
}

// Whether the walk of a cleaned animation finds a block that the cleaning removes (the check of the output)
export function pngChunkTypes(input: Buffer): string[] {
  const types: string[] = []
  let cursor = PNG_SIGNATURE.length
  while (cursor + PNG_CHUNK_OVERHEAD_BYTES <= input.length) {
    types.push(input.toString('latin1', cursor + 4, cursor + 8))
    cursor += PNG_CHUNK_OVERHEAD_BYTES + input.readUInt32BE(cursor)
  }
  return types
}
