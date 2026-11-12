import type { Readable } from 'node:stream'

import { RemittanceImportFiles } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// The body of the import of a settlement file is the file itself (text/csv, text/tab-separated-values or text/plain), up to 5 MB:
// the json parser of the app takes 100 KB and ignores these types, so the route reads its own body. It stops reading at the limit
// (the rest of the upload is never held), and a body that is not UTF-8 text is refused instead of being read with wrong letters.
const ACCEPTED: readonly string[] = [
  RemittanceImportFiles.CSV.contentType,
  RemittanceImportFiles.TSV.contentType,
  RemittanceImportFiles.PLAIN.contentType
]

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

// What was read: the text, and the bytes it was made from (the file that is kept as evidence is the one that was sent, byte for byte)
export interface ImportBody {
  text: string
  bytes: Buffer
}

// After the limit, what is left of an upload is read and thrown away only up to this much more: past it the connection is closed
const DRAIN_EXTRA_BYTES = 1024 * 1024

export async function readImportBody(
  request: Readable & { headers: Record<string, string | string[] | undefined> },
  maxBytes: number
): Promise<ImportBody> {
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
        let drained = 0
        request.on('data', (rest: Buffer | string) => {
          drained += rest.length
          if (drained > DRAIN_EXTRA_BYTES) request.destroy()
        })
        reject(tooLarge())
        return
      }
      chunks.push(buffer)
    }
    request.on('data', onData)
    request.once('end', resolve)
    request.once('error', reject)
    // A client that drops the connection mid-upload closes the request without an end: the read must not wait for ever
    request.once('close', () => {
      if (!request.readableEnded) {
        reject(
          refusal(
            ErrorCodes.REMITTANCE_IMPORT_INVALID,
            'the upload was interrupted',
            HttpStatusCodes.BAD_REQUEST
          )
        )
      }
    })
  })
  const bytes = Buffer.concat(chunks)
  try {
    // The BOM stays in the bytes that are kept, and is not part of the text that is read
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes }
  } catch {
    throw refusal(
      ErrorCodes.REMITTANCE_IMPORT_INVALID,
      'the file is not UTF-8 text',
      HttpStatusCodes.BAD_REQUEST
    )
  }
}
