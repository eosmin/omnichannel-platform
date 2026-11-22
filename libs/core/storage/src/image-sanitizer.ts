import sharp from 'sharp'

import {
  AnimatedImageCleaning,
  FILE_SIGNATURE_WINDOW_BYTES,
  ImageSanitizing,
  matchesDeclaredType,
  UploadLimits
} from '@platform/core/storage'

import {
  AnimatedImageMalformed,
  cleanGif,
  cleanPng,
  cleanWebp,
  pngChunkTypes
} from './animated-image-cleaner'

// The picture cannot be decoded, is not what it says it is, has too many pixels, does not fit the file
// limit once cleaned, or came out of the encoder with metadata still in it. It is refused: the
// original, with its metadata, is never kept.
export class ImageNotSanitizable extends Error {
  constructor(readonly reason: unknown) {
    super('the image cannot be cleaned of its metadata')
  }
}

export type SanitizedImage =
  | { kind: 'sanitized'; body: Buffer }
  // Left exactly as it came: a type that is not cleaned, or an animation that carried nothing to cut
  | { kind: 'untouched'; why: 'type' | 'animated' }

// The format the decoder must find in the bytes for each type the sanitizer re-encodes
const FORMAT_OF: Readonly<Record<string, 'jpeg' | 'png' | 'webp' | 'gif'>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

// Whether a type is re-encoded: the caller asks before it reads the file
export const isSanitizedType = (contentType: string): boolean =>
  ImageSanitizing.CONTENT_TYPES.some(type => type === contentType) &&
  Object.hasOwn(FORMAT_OF, contentType)

// The metadata blocks of an animation cut out of its container (the frames, delays and loop are the same bytes)
function cleanAnimation(input: Buffer, format: 'gif' | 'webp' | 'png'): Buffer {
  if (format === 'gif') return cleanGif(input)
  if (format === 'webp') return cleanWebp(input)
  return cleanPng(input)
}

// What the cleaned animation must still be: the same frames at the same size, nothing the cleaning cuts, and its animation chunk
async function checkCleanedAnimation(
  before: Buffer,
  after: Buffer,
  format: 'gif' | 'webp' | 'png'
): Promise<void> {
  if (format === 'png') {
    const types = pngChunkTypes(after)
    const dropped = AnimatedImageCleaning.PNG_DROPPED_CHUNKS as readonly string[]
    if (types.some(type => dropped.includes(type)) || !types.includes('acTL')) {
      throw new ImageNotSanitizable('the cleaned animation is not what it should be')
    }
    return
  }
  const options = { limitInputPixels: ImageSanitizing.MAX_INPUT_PIXELS, pages: -1 }
  const [was, is] = await Promise.all([
    sharp(before, options).metadata(),
    sharp(after, options).metadata()
  ])
  if (
    is.format !== format ||
    is.width !== was.width ||
    is.height !== was.height ||
    is.pages !== was.pages ||
    is.exif !== undefined ||
    is.xmp !== undefined
  ) {
    throw new ImageNotSanitizable('the cleaned animation is not what it should be')
  }
}

const PNG_SIGNATURE_BYTES = 8
const PNG_CHUNK_HEADER_BYTES = 8 // Length and type
const PNG_CHUNK_TRAILER_BYTES = 4 // CRC

// An animated PNG has an `acTL` chunk before the first `IDAT`; the decoder would draw only the first
// frame, so such a file is not re-encoded. The chunks are walked, not searched for the four letters: a
// text chunk that holds them is not an animation.
function isAnimatedPng(input: Buffer): boolean {
  let at = PNG_SIGNATURE_BYTES
  while (at + PNG_CHUNK_HEADER_BYTES <= input.length) {
    const length = input.readUInt32BE(at)
    const type = input.toString('latin1', at + 4, at + 8)
    if (type === 'acTL') return true
    if (type === 'IDAT' || type === 'IEND') return false
    at += PNG_CHUNK_HEADER_BYTES + length + PNG_CHUNK_TRAILER_BYTES
  }
  return false
}

// Errors of the machine, not of the picture: a retry may well work, so they must not end in a refusal
const ENVIRONMENT_ERROR = /memory|ENOMEM|resource|thread|too many open|EMFILE|cannot allocate/i

// Whether an error is of the machine and not of the picture (see ENVIRONMENT_ERROR): a retry may work, so it must never end as a refusal
export const isEnvironmentError = (error: unknown): boolean =>
  error instanceof Error && ENVIRONMENT_ERROR.test(error.message)

function encode(input: Buffer, format: 'jpeg' | 'png' | 'webp', quality: number): Promise<Buffer> {
  // A photo with a small flaw in its tail is still a photo; only a file that cannot be decoded fails.
  // The orientation is applied to the pixels and the colour profile stays; the rest is dropped.
  const pipeline = sharp(input, {
    limitInputPixels: ImageSanitizing.MAX_INPUT_PIXELS,
    failOn: 'error'
  })
    .rotate()
    .keepIccProfile()
  if (format === 'jpeg') return pipeline.jpeg({ quality }).toBuffer()
  if (format === 'webp') return pipeline.webp({ quality }).toBuffer()
  return pipeline.png({ compressionLevel: 9 }).toBuffer()
}

// Whether a picture carries what the cleaning removes (EXIF, XMP, IPTC, the Photoshop block). It reads the header only. The check of the
// output of `sanitizeImage` and the check of a stored picture (`ExistingPictureSanitizer`) are this one.
export async function carriesMetadata(body: Buffer): Promise<boolean> {
  const header = await sharp(body, {
    limitInputPixels: ImageSanitizing.MAX_INPUT_PIXELS
  }).metadata()
  // A gif and an animation are cleaned in the container, not re-encoded: they carry metadata when the walk of the cleaner would cut a block
  const animated =
    header.format === 'gif' ||
    ((header.pages ?? 1) > 1 && header.format === 'webp') ||
    (header.format === 'png' && isAnimatedPng(body))
  if (animated) {
    try {
      return cleanAnimation(body, header.format as 'gif' | 'webp' | 'png').length !== body.length
    } catch (error) {
      if (error instanceof AnimatedImageMalformed) throw new ImageNotSanitizable(error.why)
      throw error
    }
  }
  return (
    header.exif !== undefined ||
    header.xmp !== undefined ||
    header.iptc !== undefined ||
    header.tifftagPhotoshop !== undefined
  )
}

// The decodes in flight in this process, bounded by `ImageSanitizing.MAX_CONCURRENT_DECODES` (a queue of waiters: first come, first
// served). Whoever calls the cleaner, the heavy queue or a sweep, shares it.
let decodesInFlight = 0
const waiting: (() => void)[] = []
export async function withDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (decodesInFlight >= ImageSanitizing.MAX_CONCURRENT_DECODES) {
    await new Promise<void>(resolve => waiting.push(resolve))
  } else {
    decodesInFlight += 1
  }
  try {
    return await work()
  } finally {
    // The slot passes to the next waiter without being freed, so the count never dips under the bound
    const next = waiting.shift()
    if (next === undefined) decodesInFlight -= 1
    else next()
  }
}

// The one place where a picture is cleaned of its metadata, used for what an agent uploads and for
// what a customer sends alike (both reach the scan of the media pipeline). The type is checked against
// the bytes before anything is decoded, the pixels are bounded before anything is decoded whole, the
// EXIF orientation is applied to the pixels so that the picture stays upright, the result must fit the
// file limit (the quality goes down a step at a time to make it so) and is checked: one that still holds
// EXIF, XMP or IPTC is refused. An error of the machine (memory, threads) propagates, so the queue
// retries; any other is the picture's.
export function sanitizeImage(
  input: Buffer,
  contentType: string,
  maxBytes: number = UploadLimits.MAX_FILE_SIZE_BYTES
): Promise<SanitizedImage> {
  return withDecodeSlot(() => sanitizeWithinSlot(input, contentType, maxBytes))
}

async function sanitizeWithinSlot(
  input: Buffer,
  contentType: string,
  maxBytes: number
): Promise<SanitizedImage> {
  const expected = FORMAT_OF[contentType]
  if (expected === undefined || !isSanitizedType(contentType)) {
    return { kind: 'untouched', why: 'type' }
  }
  if (!matchesDeclaredType(contentType, input.subarray(0, FILE_SIGNATURE_WINDOW_BYTES))) {
    throw new ImageNotSanitizable('the bytes are not those of the declared type')
  }
  try {
    const header = await sharp(input, {
      limitInputPixels: ImageSanitizing.MAX_INPUT_PIXELS
    }).metadata()
    if (header.format !== expected) {
      throw new ImageNotSanitizable('the decoder found another format')
    }
    const { width, height } = header
    if (
      width === undefined ||
      height === undefined ||
      width * height > ImageSanitizing.MAX_INPUT_PIXELS
    ) {
      throw new ImageNotSanitizable('the size of the picture is missing or too big')
    }
    // A gif and an animation are never re-encoded: the blocks that carry metadata are cut from the container and the rest is copied
    // byte for byte. The result is read back (same size, same frames) before it replaces anything
    if (
      expected === 'gif' ||
      (header.pages ?? 1) > 1 ||
      (expected === 'png' && isAnimatedPng(input))
    ) {
      const format = expected === 'jpeg' ? undefined : expected
      if (format === undefined) throw new ImageNotSanitizable('a jpeg cannot be an animation')
      const body = cleanAnimation(input, format)
      if (body.length === input.length) return { kind: 'untouched', why: 'animated' }
      await checkCleanedAnimation(input, body, format)
      return { kind: 'sanitized', body }
    }

    // A png has no quality to lower: it is encoded once
    const qualities = expected === 'png' ? [0] : ImageSanitizing.QUALITIES
    let body: Buffer | undefined
    for (const quality of qualities) {
      body = await encode(input, expected, quality)
      if (body.length <= maxBytes) break
    }
    if (body === undefined || body.length > maxBytes) {
      throw new ImageNotSanitizable('the cleaned picture does not fit the file limit')
    }

    if (await carriesMetadata(body)) {
      throw new ImageNotSanitizable('the new file still has metadata')
    }
    return { kind: 'sanitized', body }
  } catch (error) {
    if (error instanceof ImageNotSanitizable) throw error
    if (error instanceof AnimatedImageMalformed) throw new ImageNotSanitizable(error.why)
    if (isEnvironmentError(error)) throw error
    throw new ImageNotSanitizable(error)
  }
}
