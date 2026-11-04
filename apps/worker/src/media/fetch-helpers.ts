import {
  AllowedContentTypes,
  GENERIC_CONTENT_TYPE,
  sniffDeclarableType
} from '@platform/core/storage'

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

// The image type a file's first bytes announce, for a server that did not declare one. null when they
// announce none of the types the platform keeps. The scan and the decoder judge the rest.
export function sniffImageType(body: Buffer): string | null {
  return sniffDeclarableType(body, AllowedContentTypes.IMAGE)
}
