import { createHash } from 'node:crypto'

import { csvHeader, csvLine } from '@platform/core/exports'
import type { BookCell } from '@platform/core/finance'

// The CSV of a legal book (TDD_18 §7): the header of the layout and one row per source, nothing else. No clock, no user and no random
// value goes into it, so the file of a closed month is the same bytes every time (Step 4B.8b-3). The cells go through the writer of every
// other export: a text that starts like a formula is written as text, and a number is written as a number (whole cents).
export interface BookFile {
  readonly header: readonly string[]
  readonly rows: readonly (readonly BookCell[])[]
}

export const bookCsv = (book: BookFile): string =>
  csvHeader(book.header) + book.rows.map(row => csvLine(row)).join('')

export const bookSha256 = (csv: string): string =>
  createHash('sha256').update(csv, 'utf8').digest('hex')
