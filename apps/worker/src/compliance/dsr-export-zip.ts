import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'

import { ZipFile } from 'yazl'

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

// The export as ONE ZIP, produced as a stream so it can be sent to the bucket while it is made: the text is held (bounded by
// `DSR_EXPORT_MAX_BYTES`, refused here before anything is made), the files are read one at a time, only when the ZIP reaches them, and are
// never held whole. A counter on the output stops the stream with `DsrExportTooLargeError` as soon as the ZIP passes `DSR_EXPORT_MAX_ZIP_BYTES`
// (the bytes that come out, not the sizes that were declared). A file that is gone or cannot be read fails the whole stream: an export with a
// hole in it would pass for the whole of the data of the person. The manifest is the last entry and carries the SHA-256 of every other.
export function streamDsrZip(
  content: DsrExportContent,
  meta: { type: string; generatedAt: Date },
  source: DsrFileSource
): { stream: Readable; written: () => number } {
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

  const zip = new ZipFile()
  const entries = new Map<string, Entry>()
  let written = 0
  const output = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      written += chunk.length
      if (written > ComplianceConfig.DSR_EXPORT_MAX_ZIP_BYTES) done(new DsrExportTooLargeError())
      else done(null, chunk)
    }
  })
  // One failure ends the whole stream, whichever part it came from
  const fail = (error: Error): void => {
    output.destroy(error)
  }
  zip.outputStream.on('error', fail)

  for (const entry of text) {
    entries.set(entry.name, {
      sha256: createHash('sha256').update(entry.body).digest('hex'),
      bytes: entry.body.length
    })
    zip.addBuffer(entry.body, entry.name)
  }
  for (const attachment of content.attachments) {
    async function* read(): AsyncGenerator<Buffer> {
      const body = await source.stream(attachment.key)
      if (body === null) throw new Error('a file of the export is not in the bucket')
      const hash = createHash('sha256')
      let bytes = 0
      for await (const chunk of body) {
        const part = chunk as Buffer
        hash.update(part)
        bytes += part.length
        yield part
      }
      entries.set(attachment.entry, { sha256: hash.digest('hex'), bytes })
    }
    const file = Readable.from(read(), { objectMode: false })
    file.on('error', fail)
    zip.addReadStream(file, attachment.entry)
  }
  function* manifest(): Generator<Buffer> {
    // The ZIP reads its entries in order, so every file is read to its end by now
    const listed = [...text.map(entry => entry.name), ...content.attachments.map(a => a.entry)]
    yield Buffer.from(
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
  }
  const manifestStream = Readable.from(manifest(), { objectMode: false })
  manifestStream.on('error', fail)
  zip.addReadStream(manifestStream, 'manifest.json')
  zip.end()
  zip.outputStream.pipe(output)
  return { stream: output, written: () => written }
}
