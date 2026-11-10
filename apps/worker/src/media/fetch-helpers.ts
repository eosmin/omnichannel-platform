import {
  AllowedContentTypes,
  AUDIO_MP4_CONTENT_TYPE,
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

// The host of a link, and nothing else of it: no path, query, fragment, port or credentials. For the
// diagnostic of a link that was refused, which must never keep the link itself (it can carry a signature
// that opens the file). Null when the reference is not a link or the host is not a plain name or IPv4.
export function linkHostOf(link: string): string | null {
  try {
    const { hostname } = new URL(link)
    return /^[a-z0-9._-]{1,253}$/.test(hostname) ? hostname : null
  } catch {
    return null
  }
}

// What a file server says when it does not know the type: the declared one of the webhook, or the
// bytes themselves, then decide
export const GENERIC_TYPES: ReadonlySet<string> = new Set([
  '',
  GENERIC_CONTENT_TYPE,
  'binary/octet-stream',
  'application/x-download'
])

// The names a server gives an m4a besides the registered one
const AUDIO_MP4_ALIASES: ReadonlySet<string> = new Set([
  'audio/x-m4a',
  'audio/m4a',
  'audio/mp4a-latm'
])
const VIDEO_MP4 = 'video/mp4'

// The type a fetched file is kept as. A server that does not know (`declared` generic) leaves the type
// of the webhook. An audio clip in an mp4 container comes from a server as `video/mp4` or `audio/x-m4a`
// (Instagram voice messages do): when the message said it was audio, it is kept as `audio/mp4`, the same
// container and the same signature, so the thread plays it as audio.
export function keptContentType(declared: string, webhookType: string): string {
  const fromWebhook = bareType(webhookType)
  const type = GENERIC_TYPES.has(declared) ? fromWebhook : declared
  if (AUDIO_MP4_ALIASES.has(type)) return AUDIO_MP4_CONTENT_TYPE
  if (type === VIDEO_MP4 && fromWebhook === AUDIO_MP4_CONTENT_TYPE) {
    return AUDIO_MP4_CONTENT_TYPE
  }
  return type
}

// The image type a file's first bytes announce, for a server that did not declare one. null when they
// announce none of the types the platform keeps. The scan and the decoder judge the rest.
export function sniffImageType(body: Buffer): string | null {
  return sniffDeclarableType(body, AllowedContentTypes.IMAGE)
}
