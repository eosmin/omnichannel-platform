import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'

import { configure, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'

import { ComplianceConfig } from '@platform/core/compliance'

import {
  DSR_EXPORT_EXCLUDED,
  type DsrExportContent,
  DsrExportTooLargeError
} from './dsr-export-data'

// Where the bytes of a file of the person are read from: the bucket, a key at a time
export interface DsrFileSource {
  stream(key: string): Promise<Readable | null>
}

interface Entry {
  sha256: string
  bytes: number
}

// The writer runs on the main thread: no worker, no file of the library fetched at run time
configure({ useWebWorkers: false })

// The export as ONE ZIP, encrypted with AES-256 (WinZip AE-2: a salt and a check value per entry, PBKDF2 and HMAC-SHA1 authentication of the
// bytes, so an altered entry is refused when it is opened), produced as a stream so it can be sent to the bucket while it is made: the text is
// held (bounded by `DSR_EXPORT_MAX_BYTES`, refused here before anything is made), the files are read one at a time, only when the ZIP reaches
// them, and are never held whole. A counter on the output stops the stream with `DsrExportTooLargeError` as soon as the ZIP passes
// `DSR_EXPORT_MAX_ZIP_BYTES` (the bytes that come out, not the sizes that were declared). A file that is gone or cannot be read fails the whole
// stream: an export with a hole in it would pass for the whole of the data of the person. The manifest is the last entry and carries the SHA-256
// of every other. The names of the entries are NOT encrypted by the format, which is why the files are numbered (`dsrFileEntryName`).
export function streamDsrZip(
  content: DsrExportContent,
  meta: { type: string; generatedAt: Date },
  source: DsrFileSource,
  password: string
): { stream: Readable; written: () => number } {
  if (password.length < ComplianceConfig.DSR_EXPORT_MIN_PASSWORD_LENGTH)
    throw new Error('the password of the export is too short')
  const text = content.files.map(file => {
    const body = Buffer.from(`${JSON.stringify(file.json, null, 2)}\n`, 'utf8')
    return { name: file.name, body }
  })
  // The text is bounded before it is compressed: a ZIP of a few small-looking files can inflate to more than the memory of the worker
  if (
    text.reduce((sum, entry) => sum + entry.body.length, 0) > ComplianceConfig.DSR_EXPORT_MAX_BYTES
  ) {
    throw new DsrExportTooLargeError()
  }

  const entries = new Map<string, Entry>()
  let written = 0
  const output = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      written += chunk.length
      if (written > ComplianceConfig.DSR_EXPORT_MAX_ZIP_BYTES) done(new DsrExportTooLargeError())
      else done(null, chunk)
    }
  })
  const pipe = new TransformStream<Uint8Array, Uint8Array>()
  const writer = new ZipWriter(pipe.writable, {
    password,
    encryptionStrength: ComplianceConfig.DSR_EXPORT_ZIP_AES_STRENGTH,
    zipCrypto: false,
    // AE-2: no CRC of the plain bytes in the clear (it would let a guess of a small file be checked without the password)
    useWebWorkers: false,
    extendedTimestamp: false,
    lastModDate: meta.generatedAt
  })
  // One failure ends the whole stream, whichever part it came from
  const open: Readable[] = []
  const source$ = Readable.fromWeb(pipe.readable)
  const fail = (error: unknown): void => {
    output.destroy(error instanceof Error ? error : new Error('the ZIP of the export failed'))
    source$.destroy()
    for (const stream of open) stream.destroy()
    void pipe.writable.abort().catch(() => undefined)
  }
  source$.on('error', fail)
  // A failure or an abandon on the output side (the byte limit, a bucket upload that aborts) tears the whole pipeline down too: otherwise the
  // writer waits forever for a reader and the body of a file stays open
  output.on('error', fail)
  output.once('close', () => {
    if (!output.readableEnded) fail(new Error('the ZIP of the export was abandoned'))
  })
  source$.pipe(output)

  const options = {
    level: ComplianceConfig.DSR_EXPORT_ZIP_LEVEL,
    lastModDate: meta.generatedAt,
    extendedTimestamp: false
  }
  async function build(): Promise<void> {
    for (const entry of text) {
      entries.set(entry.name, {
        sha256: createHash('sha256').update(entry.body).digest('hex'),
        bytes: entry.body.length
      })
      await writer.add(entry.name, new Uint8ArrayReader(entry.body), options)
    }
    for (const attachment of content.attachments) {
      async function* read(): AsyncGenerator<Buffer> {
        const body = await source.stream(attachment.key)
        if (body === null) throw new Error('a file of the export is not in the bucket')
        const hash = createHash('sha256')
        let bytes = 0
        try {
          for await (const chunk of body) {
            const part = chunk as Buffer
            hash.update(part)
            bytes += part.length
            yield part
          }
        } finally {
          body.destroy()
        }
        // A body that ended early (a dropped connection, an object replaced after the size was read) is a hole, not a smaller file
        if (bytes !== attachment.size)
          throw new Error('a file of the export is not the size the bucket reported')
        entries.set(attachment.entry, { sha256: hash.digest('hex'), bytes })
      }
      const file = Readable.from(read(), { objectMode: false })
      open.push(file)
      await writer.add(attachment.entry, Readable.toWeb(file), options)
    }
    // Every file has been read to its end by now
    const listed = [...text.map(entry => entry.name), ...content.attachments.map(a => a.entry)]
    const manifest = Buffer.from(
      `${JSON.stringify(
        {
          type: meta.type,
          generatedAt: meta.generatedAt.toISOString(),
          counts: content.counts,
          files: listed.map(name => {
            const entry = entries.get(name)
            if (entry === undefined) throw new Error('an entry of the export was not read')
            return { name, sha256: entry.sha256, bytes: entry.bytes }
          }),
          notIncluded: DSR_EXPORT_EXCLUDED
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    await writer.add('manifest.json', new Uint8ArrayReader(manifest), options)
    await writer.close()
  }
  build().catch(fail)
  return { stream: output, written: () => written }
}
