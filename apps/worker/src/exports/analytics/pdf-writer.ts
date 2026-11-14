import { MetricUnits, type MetricUnit } from '@platform/core/analytics'

import type { ReportSheet } from './sheet'

// A minimal PDF written by hand: pages of text and lines, in the standard Helvetica every reader has (no font is embedded, no
// image, no script, no link). A report is a table of figures; a rendering library would be a large dependency for it. The words
// are Latin-1 (Spanish and English); a character outside it is written as "?".

const PAGE = { width: 842, height: 595, margin: 36 } as const // A4 landscape, in points
const FIRST_COLUMN_WIDTH = 74
const MAX_METRIC_COLUMNS = 8
const BODY_SIZE = 8
const HEADER_SIZE = 7
const TITLE_SIZE = 14
const ROW_HEIGHT = 13
const HEADER_LINES = 3
const HELVETICA_WIDTH = 0.52 // an average width of a character, as a fraction of the size
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const CENTS = 100

const LATIN1 = /[^\u0020-\u007E\u00A0-\u00FF]/gu

// The text of a string object: Latin-1 as octal escapes for what is not ASCII, and the three characters that end or open a string
export function pdfText(value: string): string {
  let out = ''
  for (const char of value.replace(LATIN1, '?')) {
    const code = char.charCodeAt(0)
    if (char === '\\' || char === '(' || char === ')') out += `\\${char}`
    else if (code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`
    else out += char
  }
  return out
}

// Seconds as a person reads them: "1 h 05 min", "3 min 42 s", "40 s"
export function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds)
  const hours = Math.floor(whole / SECONDS_PER_HOUR)
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const rest = whole % SECONDS_PER_MINUTE
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`
  if (minutes > 0) return `${minutes} min ${String(rest).padStart(2, '0')} s`
  return `${rest} s`
}

export function formatCell(value: number | null, unit: MetricUnit): string {
  if (value === null || !Number.isFinite(value)) return '-'
  if (unit === MetricUnits.SECONDS) return formatSeconds(value)
  if (unit === MetricUnits.CENTS) return (value / CENTS).toFixed(2)
  return String(Math.round(value))
}

// Words cut to lines no wider than a column, at most `maxLines`; what does not fit is cut with no mark (the header says it whole in
// the sheet of a spreadsheet)
function wrap(text: string, width: number, size: number, maxLines: number): string[] {
  const perLine = Math.max(4, Math.floor(width / (size * HELVETICA_WIDTH)))
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const piece = word.length > perLine ? word.slice(0, perLine) : word
    if (line !== '' && `${line} ${piece}`.length > perLine) {
      lines.push(line)
      line = piece
    } else {
      line = line === '' ? piece : `${line} ${piece}`
    }
  }
  if (line !== '') lines.push(line)
  return lines.slice(0, maxLines)
}

interface Page {
  ops: string[]
}

const BOLD = 'F2'
const REGULAR = 'F1'

function put(page: Page, font: string, size: number, x: number, y: number, text: string): void {
  page.ops.push(`BT /${font} ${size} Tf ${x} ${y} Td (${pdfText(text)}) Tj ET`)
}

function rule(page: Page, y: number): void {
  page.ops.push(`0.7 G ${PAGE.margin} ${y} m ${PAGE.width - PAGE.margin} ${y} l S`)
}

// The right edge of a figure is the right edge of its column
function putRight(
  page: Page,
  font: string,
  size: number,
  right: number,
  y: number,
  text: string
): void {
  const x = Math.max(PAGE.margin, right - text.length * size * HELVETICA_WIDTH)
  put(page, font, size, Math.round(x), y, text)
}

export function buildPdf(sheet: ReportSheet): Uint8Array {
  const pages: Page[] = []
  const groups: number[][] = []
  const metricCount = sheet.headers.length - 1
  for (let start = 0; start < Math.max(metricCount, 1); start += MAX_METRIC_COLUMNS) {
    groups.push(
      Array.from({ length: Math.min(MAX_METRIC_COLUMNS, metricCount - start) }, (_, i) => start + i)
    )
  }
  const usable = PAGE.width - 2 * PAGE.margin - FIRST_COLUMN_WIDTH
  for (const group of groups) {
    const columnWidth = usable / Math.max(group.length, 1)
    let page: Page | null = null
    let y = 0
    const newPage = (): Page => {
      const created: Page = { ops: [] }
      pages.push(created)
      y = PAGE.height - PAGE.margin
      if (pages.length === 1) {
        put(created, BOLD, TITLE_SIZE, PAGE.margin, y - TITLE_SIZE, sheet.title)
        put(created, REGULAR, BODY_SIZE + 1, PAGE.margin, y - TITLE_SIZE - 14, sheet.subtitle)
        y -= TITLE_SIZE + 34
      }
      // The header of the table, on every page
      const header = group.map(index =>
        wrap(sheet.headers[index + 1] ?? '', columnWidth - 4, HEADER_SIZE, HEADER_LINES)
      )
      put(created, BOLD, HEADER_SIZE, PAGE.margin, y - HEADER_SIZE, sheet.headers[0] ?? '')
      group.forEach((_, position) => {
        const right = PAGE.margin + FIRST_COLUMN_WIDTH + columnWidth * (position + 1) - 2
        header[position]?.forEach((line, lineIndex) => {
          putRight(
            created,
            BOLD,
            HEADER_SIZE,
            right,
            y - HEADER_SIZE - lineIndex * (HEADER_SIZE + 2),
            line
          )
        })
      })
      y -= HEADER_LINES * (HEADER_SIZE + 2) + 2
      rule(created, y)
      y -= ROW_HEIGHT - 3
      return created
    }
    page = newPage()
    for (const row of sheet.rows) {
      if (y < PAGE.margin + ROW_HEIGHT) page = newPage()
      const font = row.total ? BOLD : REGULAR
      if (row.total) rule(page, y + BODY_SIZE + 2)
      put(page, font, BODY_SIZE, PAGE.margin, y, row.label)
      group.forEach((index, position) => {
        const right = PAGE.margin + FIRST_COLUMN_WIDTH + columnWidth * (position + 1) - 2
        const unit = sheet.units[index] ?? MetricUnits.COUNT
        putRight(
          page as Page,
          font,
          BODY_SIZE,
          right,
          y,
          formatCell(row.values[index] ?? null, unit)
        )
      })
      y -= ROW_HEIGHT
    }
  }
  return assemble(pages)
}

// Objects: 1 catalog, 2 pages, 3 and 4 the two fonts, then a page and its content for each page
function assemble(pages: readonly Page[]): Uint8Array {
  const objects: string[] = []
  const pageIds = pages.map((_, index) => 5 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  pages.forEach((page, index) => {
    const content = page.ops.join('\n')
    objects[5 + index * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`
    objects[6 + index * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  })
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = body.length
  const table = offsets
    .slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  // Latin-1: one byte for each character, so the offsets above are byte offsets
  return Uint8Array.from(body, char => char.charCodeAt(0))
}
