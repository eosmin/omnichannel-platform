import type { Readable } from 'node:stream'

import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// The body of the import of a settlement file is the file itself (text/csv, text/tab-separated-values or text/plain), up to 5 MB:
// the json parser of the app takes 100 KB and ignores these types, so the route reads its own body. It stops reading at the limit
// (the rest of the upload is never held), and a body that is not UTF-8 text is refused instead of being read with wrong letters.
export const ImportContentTypes = {
  CSV: 'text/csv',
  TSV: 'text/tab-separated-values',
  PLAIN: 'text/plain'
} as const

const ACCEPTED: readonly string[] = Object.values(ImportContentTypes)

function refusal(
  code: typeof ErrorCodes.REMITTANCE_IMPORT_INVALID | typeof ErrorCodes.PAYLOAD_TOO_LARGE,
  message: string,
  status: number
): PlatformException {
  return new PlatformException(code, message, status)
}

// The media type without its parameters ('text/csv; charset=utf-8' is 'text/csv')
export function mediaTypeOf(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

export function isImportContentType(header: string | undefined): boolean {
  return ACCEPTED.includes(mediaTypeOf(header))
}

export async function readImportBody(
  request: Readable & { headers: Record<string, string | string[] | undefined> },
  maxBytes: number
): Promise<string> {
  const length = Number(request.headers['content-length'])
  if (Number.isFinite(length) && length > maxBytes) {
    throw refusal(
      ErrorCodes.PAYLOAD_TOO_LARGE,
      'the file is larger than a settlement file may be',
      HttpStatusCodes.PAYLOAD_TOO_LARGE
    )
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > maxBytes) {
      request.destroy()
      throw refusal(
        ErrorCodes.PAYLOAD_TOO_LARGE,
        'the file is larger than a settlement file may be',
        HttpStatusCodes.PAYLOAD_TOO_LARGE
      )
    }
    chunks.push(buffer)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw refusal(
      ErrorCodes.REMITTANCE_IMPORT_INVALID,
      'the file is not UTF-8 text',
      HttpStatusCodes.BAD_REQUEST
    )
  }
}
