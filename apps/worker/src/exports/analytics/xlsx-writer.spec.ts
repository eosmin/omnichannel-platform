import { strFromU8, unzipSync } from 'fflate'

import type { ReportSheet } from './sheet'
import { buildXlsx, escapeXml, sheetNameOf } from './xlsx-writer'

const sheet: ReportSheet = {
  title: 'Weekly',
  subtitle: 'From 2026-11-02 to 2026-11-09',
  headers: ['Day', 'Orders', 'Revenue (USD)'],
  units: ['count', 'cents'],
  rows: [
    { label: '2026-11-02', values: [3, 12_050], total: false },
    { label: '2026-11-03', values: [null, 0], total: false },
    { label: 'Total', values: [3, 12_050], total: true }
  ]
}

const sheetXml = (file: Uint8Array): string =>
  strFromU8(unzipSync(file)['xl/worksheets/sheet1.xml'] ?? new Uint8Array())

describe('buildXlsx', () => {
  it('is a zip with the parts of a workbook', () => {
    const files = Object.keys(unzipSync(buildXlsx(sheet))).sort()
    expect(files).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml'
    ])
  })

  it('writes numbers as numbers and an empty figure as no cell', () => {
    const xml = sheetXml(buildXlsx(sheet))
    expect(xml).toContain('<c r="B5"><v>3</v></c>')
    // Money is in whole units: the rollup keeps cents
    expect(xml).toContain('<c r="C5"><v>120.5</v></c>')
    expect(xml).not.toContain('r="B6"')
  })

  it('writes every text as an inline string and never a formula', () => {
    const hostile: ReportSheet = {
      ...sheet,
      title: '=HYPERLINK("http://evil.example","x")',
      headers: ['Day', '+cmd|calc', '@SUM(A1)'],
      rows: [{ label: '-2+3', values: [1, 2], total: false }]
    }
    const xml = sheetXml(buildXlsx(hostile))
    expect(xml).not.toContain('<f>')
    expect(xml).not.toContain('<f ')
    // The text sits inside a string, where a spreadsheet shows it as it is
    expect(xml).toContain(
      't="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://evil.example&quot;,&quot;x&quot;)</t>'
    )
    expect(xml).toContain('+cmd|calc')
    expect(xml).toContain('-2+3')
  })

  it('escapes the characters of XML and drops the ones a document cannot hold', () => {
    expect(escapeXml('a<b>&"c\u0000d\u0008')).toBe('a&lt;b&gt;&amp;&quot;cd')
  })

  it('names the sheet without the characters a sheet name refuses, in 31 characters', () => {
    const workbook = strFromU8(
      unzipSync(buildXlsx({ ...sheet, title: 'Ventas/[mes]: ' + 'x'.repeat(40) }))[
        'xl/workbook.xml'
      ] ?? new Uint8Array()
    )
    const name = /<sheet name="([^"]*)"/.exec(workbook)?.[1] ?? ''
    expect(name).not.toMatch(/[[\]:*?/\\]/)
    expect(Array.from(name).length).toBeLessThanOrEqual(31)
  })

  it('numbers the columns past Z', () => {
    const wide: ReportSheet = {
      ...sheet,
      headers: Array.from({ length: 30 }, (_, i) => `h${i}`),
      rows: []
    }
    expect(sheetXml(buildXlsx(wide))).toContain('r="AD4"')
  })
})

describe('sheetNameOf', () => {
  it.each([
    ["'Weekly'", 'Weekly'],
    ["Ventas'", 'Ventas'],
    ['History', 'Report'],
    ['  ', 'Report'],
    ["''", 'Report'],
    ['a/b:c', 'a b c']
  ])('writes %s as %s', (title, name) => {
    expect(sheetNameOf(title)).toBe(name)
  })
})
