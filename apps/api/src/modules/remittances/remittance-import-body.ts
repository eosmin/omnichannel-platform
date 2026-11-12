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
  // Read with events and not with `for await`, which destroys the request when it stops early: the client must still get its answer
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    const tooLarge = () =>
      refusal(
        ErrorCodes.PAYLOAD_TOO_LARGE,
        'the file is larger than a settlement file may be',
        HttpStatusCodes.PAYLOAD_TOO_LARGE
      )
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) {
        request.off('data', onData)
        // Nothing more is kept: what is left of the upload is read and thrown away, so the answer can go out
        request.on('data', () => undefined)
        reject(tooLarge())
        return
      }
      chunks.push(buffer)
    }
    request.on('data', onData)
    request.once('end', resolve)
    request.once('error', reject)
  })
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
