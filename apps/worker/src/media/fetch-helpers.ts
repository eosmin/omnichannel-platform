import { GENERIC_CONTENT_TYPE } from '@platform/core/storage'

// What a file that came from outside is read with, whoever fetched it: the plugin for a file of a
// message, the core for the picture of an ad
export class FileRefused extends Error {}

// "image/jpeg; charset=x" is "image/jpeg"
export const bareType = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase()

export async function readLimited(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += part.length
    if (total > maxBytes) {
      ;(stream as { destroy?: () => void }).destroy?.()
      throw new FileRefused('the file is bigger than the limit')
    }
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

// What a file server says when it does not know the type: the declared one of the webhook, or the
// bytes themselves, then decide
export const GENERIC_TYPES: ReadonlySet<string> = new Set([
  '',
  GENERIC_CONTENT_TYPE,
  'binary/octet-stream',
  'application/x-download'
])

const startsWith = (body: Buffer, bytes: readonly number[], at = 0): boolean =>
  bytes.every((byte, index) => body[at + index] === byte)

// The image type a file's first bytes announce, for a server that did not declare one. null when they
// announce none of the types the platform keeps. The scan and the decoder judge the rest.
export function sniffImageType(body: Buffer): string | null {
  if (startsWith(body, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(body, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  // RIFF....WEBP
  if (startsWith(body, [0x52, 0x49, 0x46, 0x46]) && startsWith(body, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'
  }
  return null
}
