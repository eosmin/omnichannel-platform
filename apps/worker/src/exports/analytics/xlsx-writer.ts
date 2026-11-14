import { strToU8, zipSync } from 'fflate'

import { MetricUnits } from '@platform/core/analytics'

import { displayValue, type ReportSheet } from './sheet'

// A minimal .xlsx (Office Open XML) written by hand: one sheet, text and numbers. No library: a report is a table, and a spreadsheet
// engine would be a large dependency for it.
//
// Every text is an inline string (`t="inlineStr"`), which a spreadsheet shows as text and never evaluates, so a name that starts with
// `=`, `+`, `-` or `@` cannot become a formula; there is no `<f>` element anywhere in what this writes. A number is a number.

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const SHEET_NAME_MAX = 31
// What XML 1.0 does not allow in a document at all, and what a sheet name may not hold
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g
const INVALID_SHEET_NAME = /[[\]:*?/\\]/g

export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// Column letters of a zero-based index: 0 is A, 26 is AA
function columnName(index: number): string {
  let name = ''
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
  }
  return name
}

type Cell = string | number | null

// style 1 is the bold of a header and of the total row
function cellXml(reference: string, value: Cell, bold: boolean): string {
  const style = bold ? ' s="1"' : ''
  if (value === null) return bold ? `<c r="${reference}"${style}/>` : ''
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `<c r="${reference}"${style}><v>${value}</v></c>` : ''
  }
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

function rowXml(number: number, cells: readonly Cell[], bold: boolean): string {
  const body = cells
    .map((cell, index) => cellXml(`${columnName(index)}${number}`, cell, bold))
    .join('')
  return `<row r="${number}">${body}</row>`
}

// Excel refuses a name with `[]:*?/\`, one that begins or ends with an apostrophe, a blank one, one longer than 31 characters and
// the name `History` (reserved), and reports the file as corrupt
export function sheetNameOf(title: string): string {
  const clean = title
    .replace(INVALID_SHEET_NAME, ' ')
    .replace(INVALID_XML, '')
    .replace(/^'+|'+$/g, '')
    .trim()
  const cut = Array.from(clean)
    .slice(0, SHEET_NAME_MAX)
    .join('')
    .replace(/^'+|'+$/g, '')
    .trim()
  return cut === '' || cut.toLowerCase() === 'history' ? 'Report' : cut
}

export function buildXlsx(sheet: ReportSheet): Uint8Array {
  const rows = [
    rowXml(1, [sheet.title], true),
    rowXml(2, [sheet.subtitle], false),
    rowXml(4, sheet.headers, true),
    ...sheet.rows.map((row, index) =>
      rowXml(
        5 + index,
        [
          row.label,
          ...row.values.map((value, position) =>
            displayValue(value, sheet.units[position] ?? MetricUnits.COUNT)
          )
        ],
        row.total
      )
    )
  ]
  const sheetName = sheetNameOf(sheet.title)
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    ),
    '_rels/.rels': strToU8(
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    'xl/workbook.xml': strToU8(
      `${XML_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
    ),
    'xl/styles.xml': strToU8(
      `${XML_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `${XML_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`
    )
  }
  return zipSync(files)
}
