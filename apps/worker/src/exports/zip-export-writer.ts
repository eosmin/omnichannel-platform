import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { ZipFile } from 'yazl'

import { errorName } from '@platform/core/errors'
import { ExportContentTypes, MEDIA_ZIP_MISSING_ENTRY } from '@platform/core/exports'
import { AllowedContentTypes } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { type ZipSource, ZipEmptyError } from './media-zip-export.source'
import { ZipEntryNames } from './zip-entry-names'

// Images, video, audio and Office files are compressed already: deflating them again costs CPU for
// nothing. Only plain text and PDF are worth it (the Office types are the ones with `openxml`).
const COMPRESSIBLE: ReadonlySet<string> = new Set(
  AllowedContentTypes.DOCUMENT.filter(type => !type.includes('openxml'))
)

// Streams a ZIP into the bucket while it reads the files from it, one at a time: neither the ZIP nor
// a file is ever held whole, so a ZIP of the most it may hold needs no more memory than a small one.
@Injectable()
export class ZipExportWriter {
  constructor(
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ZipExportWriter.name)
  }

  // Nothing is left at the key when the source or a file fails. `rowCount` is the files in the ZIP.
  async write(key: string, source: ZipSource): Promise<{ rowCount: number }> {
    const zip = new ZipFile()
    // yazl hands out a PassThrough, typed as the bare NodeJS.ReadableStream interface
    const output = zip.outputStream as Readable
    const names = new ZipEntryNames()
    // The report is told apart from a customer's file called the same
    names.reserve(MEDIA_ZIP_MISSING_ENTRY)
    let current: Readable | null = null
    let rowCount = 0
    const missing: string[] = []
    let feedError: unknown

    const upload = this.storage.putStream(key, output, ExportContentTypes.ZIP)
    // If the upload dies, stop reading: the loop below is waiting on a file nobody will pull
    const uploading = upload.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error('the upload failed')
      current?.destroy(failure)
      output.destroy(failure)
      throw error
    })

    const feed = async (): Promise<void> => {
      try {
        for await (const entry of source.entries()) {
          const body = await this.storage.stream(entry.key)
          if (body === null) {
            // Gone from the bucket: the ZIP holds the rest rather than nothing
            this.logger.warn({ key: entry.key }, 'a file of a ZIP is not in the bucket')
            missing.push(entry.filename)
            continue
          }
          current = body
          // The next file is not opened until this one was read to its end
          const read = finished(body)
          zip.addReadStream(body, names.next(entry.filename), {
            mtime: entry.modifiedAt,
            compress: COMPRESSIBLE.has(entry.contentType)
          })
          rowCount += 1
          await read
          current = null
        }
        // The member must be able to tell that the ZIP holds fewer files than the gallery showed
        if (missing.length > 0 && rowCount > 0) {
          zip.addBuffer(
            Buffer.from(`${missing.map(missingLine).join('\n')}\n`, 'utf8'),
            MEDIA_ZIP_MISSING_ENTRY,
            { compress: false }
          )
        }
        zip.end()
      } catch (error) {
        feedError = error
        this.logger.error({ errorName: errorName(error) }, 'a ZIP could not be written')
        const failure = error instanceof Error ? error : new Error('the ZIP failed')
        current?.destroy(failure)
        output.destroy(failure)
        throw error
      }
    }

    // The first failure wins; the other branch ends because the streams are destroyed
    try {
      await Promise.all([uploading, feed()])
    } catch (error) {
      // The upload also dies when the feed destroys the stream: the cause is the feed's
      throw feedError ?? error
    }
    // Every file was gone from the bucket: an empty ZIP is no export
    if (rowCount === 0) throw new ZipEmptyError()
    return { rowCount }
  }
}

// A name is the customer's: a line break in it would pass for two names
const missingLine = (filename: string): string => filename.replace(/[\r\n]+/g, ' ')
