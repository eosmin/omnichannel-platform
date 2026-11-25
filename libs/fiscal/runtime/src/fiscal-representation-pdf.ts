import PDFDocument from 'pdfkit'
import { encode } from 'uqr'

import { FiscalLimits } from '@platform/core/domain'
import type { FiscalRepresentation, FiscalRepresentationRow } from '@platform/fiscal/sdk'

// The picture of a document as a PDF (the graphic representation a tax authority may ask for): drawn from the model of the provider and nothing else, with the standard
// faces every reader has (nothing is embedded). The same model gives the same bytes: the dates of the file are the one it is given.

const FONT_REGULAR = 'Helvetica'
const FONT_BOLD = 'Helvetica-Bold'
const MARGIN_PT = 36
const TITLE_PT = 16
const TEXT_PT = 8
const SMALL_PT = 6.5
const GAP_PT = 4
const LABEL_WIDTH_SHARE = 0.34
const QR_SIZE_PT = 96
const QR_QUIET_MODULES = 4
const NOTICE_INK = '#b00020'
const INK = '#000000'
const RULE = '#999999'
// The characters the standard faces draw (Latin-1): any other is shown as a question mark, never as a broken glyph
const NOT_DRAWABLE = /[^\t\n\x20-\x7e\xa0-\xff]/gu

export const drawable = (value: string): string => value.replace(NOT_DRAWABLE, '?')

// The modules of the code of an address, dark ones as true: the picture draws exactly these (level M recovers up to 15 % of it)
export function qrModules(url: string): boolean[][] {
  return encode(url, { ecc: 'M' }).data
}

function drawQr(pdf: PDFKit.PDFDocument, url: string, x: number, y: number): void {
  const modules = qrModules(url)
  const total = modules.length + QR_QUIET_MODULES * 2
  const cell = QR_SIZE_PT / total
  pdf.rect(x, y, QR_SIZE_PT, QR_SIZE_PT).fill('#ffffff')
  pdf.fillColor(INK)
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) {
        pdf
          .rect(x + (c + QR_QUIET_MODULES) * cell, y + (r + QR_QUIET_MODULES) * cell, cell, cell)
          .fill(INK)
      }
    })
  )
}

function ensureRoom(pdf: PDFKit.PDFDocument, needed: number): void {
  if (pdf.y + needed > pdf.page.height - MARGIN_PT) pdf.addPage()
}

function drawRows(pdf: PDFKit.PDFDocument, rows: readonly FiscalRepresentationRow[]): void {
  const width = pdf.page.width - MARGIN_PT * 2
  const labelWidth = width * LABEL_WIDTH_SHARE
  for (const row of rows) {
    const label = drawable(row.label)
    const value = drawable(row.value)
    pdf.font(FONT_BOLD).fontSize(TEXT_PT)
    const labelHeight = pdf.heightOfString(label, { width: labelWidth - GAP_PT })
    pdf.font(FONT_REGULAR)
    const valueHeight = pdf.heightOfString(value, { width: width - labelWidth })
    ensureRoom(pdf, Math.max(labelHeight, valueHeight) + GAP_PT)
    const top = pdf.y
    pdf.font(FONT_BOLD).text(label, MARGIN_PT, top, { width: labelWidth - GAP_PT })
    pdf.font(FONT_REGULAR).text(value, MARGIN_PT + labelWidth, top, { width: width - labelWidth })
    pdf.y = top + Math.max(labelHeight, valueHeight) + GAP_PT / 2
  }
}

function heading(pdf: PDFKit.PDFDocument, text: string): void {
  ensureRoom(pdf, 30)
  pdf.moveDown(0.5)
  pdf
    .font(FONT_BOLD)
    .fontSize(TEXT_PT + 1)
    .fillColor(INK)
    .text(drawable(text), MARGIN_PT, pdf.y)
  pdf
    .moveTo(MARGIN_PT, pdf.y + 1)
    .lineTo(pdf.page.width - MARGIN_PT, pdf.y + 1)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke()
  pdf.y += GAP_PT + 1
}

function drawTable(
  pdf: PDFKit.PDFDocument,
  table: NonNullable<FiscalRepresentation['table']>
): void {
  const width = pdf.page.width - MARGIN_PT * 2
  const count = table.columns.length
  // The description takes what the amounts leave; every other column has the same share of the rest
  const description = table.wideColumn
  const narrow = (width * 0.62) / Math.max(1, count - 1)
  const widths = table.columns.map((_, index) =>
    index === description ? width - narrow * (count - 1) : narrow
  )
  const xs = widths.map((_, index) => MARGIN_PT + widths.slice(0, index).reduce((a, b) => a + b, 0))
  const cell = (value: string, index: number, top: number, bold: boolean): number => {
    const text = drawable(value)
    const options = {
      width: (widths[index] ?? narrow) - GAP_PT,
      align: table.numericColumns.includes(index) ? ('right' as const) : ('left' as const)
    }
    pdf.font(bold ? FONT_BOLD : FONT_REGULAR).fontSize(bold ? SMALL_PT : TEXT_PT - 0.5)
    const height = pdf.heightOfString(text, options)
    pdf.text(text, xs[index] ?? MARGIN_PT, top, options)
    return height
  }
  const line = (cells: readonly string[], bold: boolean): void => {
    pdf.font(bold ? FONT_BOLD : FONT_REGULAR).fontSize(bold ? SMALL_PT : TEXT_PT - 0.5)
    const needed = Math.max(
      ...cells.map((value, index) =>
        pdf.heightOfString(drawable(value), { width: (widths[index] ?? narrow) - GAP_PT })
      )
    )
    ensureRoom(pdf, needed + GAP_PT)
    const top = pdf.y
    const heights = cells.map((value, index) => cell(value, index, top, bold))
    pdf.y = top + Math.max(...heights) + GAP_PT
  }
  line(table.columns, true)
  pdf
    .moveTo(MARGIN_PT, pdf.y - GAP_PT / 2)
    .lineTo(MARGIN_PT + width, pdf.y - GAP_PT / 2)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke()
  for (const row of table.rows) line(row, false)
}

// A representation larger than what a document holds is refused before anything is drawn: the worker's time is bounded, and a text that
// was cut would be a wrong legal paper
export class RepresentationTooLargeError extends Error {
  constructor() {
    super('the representation is larger than what is drawn')
    this.name = 'RepresentationTooLargeError'
  }
}

function assertWithinLimits(representation: FiscalRepresentation): void {
  const texts = [
    representation.title,
    ...representation.notices,
    ...representation.sections.flatMap(section => [
      section.heading,
      ...section.rows.flatMap(row => [row.label, row.value])
    ]),
    ...(representation.table?.columns ?? []),
    ...(representation.table?.rows.flat() ?? []),
    ...[...representation.totals, ...representation.footnotes].flatMap(row => [
      row.label,
      row.value
    ]),
    representation.qrUrl ?? ''
  ]
  const rows =
    representation.sections.reduce((sum, section) => sum + section.rows.length, 0) +
    (representation.table?.rows.length ?? 0) +
    representation.totals.length +
    representation.footnotes.length
  if (
    rows > FiscalLimits.REPRESENTATION_MAX_ROWS ||
    texts.some(value => value.length > FiscalLimits.REPRESENTATION_MAX_TEXT_CHARS)
  ) {
    throw new RepresentationTooLargeError()
  }
}

// The file. `at` is the date written in it (the one of the document, so the same document always gives the same file).
export async function renderRepresentationPdf(
  representation: FiscalRepresentation,
  at: Date
): Promise<Buffer> {
  assertWithinLimits(representation)
  const pdf = new PDFDocument({
    size: 'LETTER',
    margin: MARGIN_PT,
    info: {
      Title: drawable(representation.title),
      CreationDate: at,
      ModDate: at
    }
  })
  const chunks: Buffer[] = []
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
    pdf.on('error', reject)
  })

  const width = pdf.page.width - MARGIN_PT * 2
  for (const notice of representation.notices) {
    pdf
      .font(FONT_BOLD)
      .fontSize(TEXT_PT + 1)
      .fillColor(NOTICE_INK)
    pdf.text(drawable(notice), MARGIN_PT, pdf.y, { width, align: 'center' })
    pdf.moveDown(0.3)
  }
  pdf.font(FONT_BOLD).fontSize(TITLE_PT).fillColor(INK)
  pdf.text(drawable(representation.title).toUpperCase(), MARGIN_PT, pdf.y, {
    width,
    align: 'center'
  })
  pdf.moveDown(0.5)

  for (const section of representation.sections) {
    heading(pdf, section.heading)
    drawRows(pdf, section.rows)
  }
  if (representation.table !== null) {
    pdf.moveDown(0.8)
    drawTable(pdf, representation.table)
  }
  if (representation.totals.length > 0) {
    pdf.moveDown(0.5)
    drawRows(pdf, representation.totals)
  }
  if (representation.footnotes.length > 0) {
    pdf.moveDown(0.5)
    drawRows(pdf, representation.footnotes)
  }
  if (representation.qrUrl !== null) {
    ensureRoom(pdf, QR_SIZE_PT + 24)
    pdf.moveDown(0.8)
    const top = pdf.y
    drawQr(pdf, representation.qrUrl, MARGIN_PT, top)
    // The address under the code, for a person who has to type it
    pdf
      .font(FONT_REGULAR)
      .fontSize(SMALL_PT)
      .fillColor(INK)
      .text(drawable(representation.qrUrl), MARGIN_PT + QR_SIZE_PT + 8, top + QR_SIZE_PT / 2 - 8, {
        width: width - QR_SIZE_PT - 8
      })
    pdf.y = top + QR_SIZE_PT
  }
  pdf.end()
  return done
}
