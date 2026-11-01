import { Readable } from 'node:stream'

import { Injectable } from '@nestjs/common'

import { type CsvValue, csvHeader, csvLine, ExportContentTypes } from '@platform/core/exports'
import { StorageService } from '@platform/core/storage-module'

// What a kind of export gives the writer: the names of its columns and its rows, one at a time. A
// source reads the database in pages, so the result of the query is never held whole.
export interface CsvSource {
  columns: readonly string[]
  rows: () => AsyncGenerator<CsvValue[]>
}

@Injectable()
export class CsvExportWriter {
  constructor(private readonly storage: StorageService) {}

  // The file goes to the bucket as it is made. Nothing is left at the key when the source fails.
  async write(key: string, source: CsvSource): Promise<{ rowCount: number }> {
    let rowCount = 0
    async function* chunks(): AsyncGenerator<string> {
      yield csvHeader(source.columns)
      for await (const row of source.rows()) {
        rowCount += 1
        yield csvLine(row)
      }
    }
    await this.storage.putStream(key, Readable.from(chunks()), ExportContentTypes.CSV)
    return { rowCount }
  }
}
