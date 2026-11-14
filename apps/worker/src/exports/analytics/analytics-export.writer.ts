import { Injectable } from '@nestjs/common'

import {
  type AnalyticsExportFilters,
  type AnalyticsFileFormat,
  daysOfPeriod,
  MetricUnits,
  ReportFormats
} from '@platform/core/analytics'
import { PrismaService } from '@platform/core/database'
import { ExportContentTypes } from '@platform/core/exports'
import { StorageService } from '@platform/core/storage-module'

import type { CsvSource } from '../csv-export-writer'
import { CsvExportWriter } from '../csv-export-writer'

import { buildPdf } from './pdf-writer'
import { readReportTable } from './report-table'
import { localeOf, reportTexts } from './report-texts'
import { displayValue, type ReportSheet, sheetOf } from './sheet'
import { buildXlsx } from './xlsx-writer'

// The CSV of a report: the headers of the sheet, the figures in seconds and in whole money units, and a last row with the totals.
// A text cell is made safe by `csvCell`, like every other CSV of the platform.
export function csvSourceOf(sheet: ReportSheet): CsvSource {
  return {
    columns: sheet.headers,
    count: () => Promise.resolve(sheet.rows.length),
    rows: async function* () {
      for (const row of sheet.rows) {
        yield [
          row.label,
          ...row.values.map((value, index) =>
            displayValue(value, sheet.units[index] ?? MetricUnits.COUNT)
          )
        ]
      }
      await Promise.resolve()
    }
  }
}

// Writes the file of an export of the analytics: the day-by-day table of the metrics of the filters, from the rollup tables
// only. The store and the person are those of the export row, never of the filters.
@Injectable()
export class AnalyticsExportWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly csv: CsvExportWriter
  ) {}

  // The days and the row of totals
  rowCount(filters: AnalyticsExportFilters): number {
    return daysOfPeriod(filters).length + 1
  }

  async write(
    key: string,
    row: { storeId: string; requestedBy: string },
    format: AnalyticsFileFormat,
    filters: AnalyticsExportFilters,
    onProgress: (done: number) => void
  ): Promise<{ rowCount: number }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: row.requestedBy },
      select: { locale: true }
    })
    const table = await readReportTable(this.prisma, row.storeId, filters)
    const texts = reportTexts(localeOf(user?.locale), {
      ...(filters.reportName === undefined ? {} : { name: filters.reportName }),
      from: filters.from,
      to: filters.to
    })
    const sheet = sheetOf(table, texts)
    if (format === ReportFormats.CSV) return this.csv.write(key, csvSourceOf(sheet), onProgress)
    const bytes = format === ReportFormats.EXCEL ? buildXlsx(sheet) : buildPdf(sheet)
    const contentType =
      format === ReportFormats.EXCEL ? ExportContentTypes.EXCEL : ExportContentTypes.PDF
    await this.storage.put(key, Buffer.from(bytes), contentType)
    onProgress(sheet.rows.length)
    return { rowCount: sheet.rows.length }
  }
}
