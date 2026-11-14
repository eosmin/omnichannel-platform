import { buildPdf, formatCell, formatSeconds, pdfText } from './pdf-writer'
import type { ReportSheet } from './sheet'

const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1')

const sheetOf = (days: number, metrics = 2): ReportSheet => ({
  title: 'Resumen semanal',
  subtitle: 'Del 2026-11-02 al 2026-11-09',
  headers: ['Día', ...Array.from({ length: metrics }, (_, i) => `Métrica ${i}`)],
  units: Array.from({ length: metrics }, () => 'count' as const),
  rows: [
    ...Array.from({ length: days }, (_, i) => ({
      label: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`,
      values: Array.from({ length: metrics }, () => i),
      total: false
    })),
    { label: 'Total', values: Array.from({ length: metrics }, () => days), total: true }
  ]
})

describe('pdfText', () => {
  it('escapes what ends or opens a string', () => {
    expect(pdfText('a(b)c\\d')).toBe('a\\(b\\)c\\\\d')
  })

  it('writes Latin-1 letters as octal escapes so the file stays ASCII', () => {
    expect(pdfText('Día')).toBe('D\\355a')
    expect(pdfText('ñ')).toBe('\\361')
  })

  it('writes a character outside Latin-1 as a question mark', () => {
    expect(pdfText('a中b\u{1F600}')).toBe('a?b?')
  })
})

describe('formatCell', () => {
  it('formats each unit for a person', () => {
    expect(formatCell(1250, 'count')).toBe('1250')
    expect(formatCell(12_050, 'cents')).toBe('120.50')
    expect(formatCell(222, 'seconds')).toBe('3 min 42 s')
    expect(formatCell(null, 'count')).toBe('-')
    expect(formatCell(Number.NaN, 'count')).toBe('-')
  })

  it('formats seconds in hours and in seconds', () => {
    expect(formatSeconds(3900)).toBe('1 h 05 min')
    expect(formatSeconds(40)).toBe('40 s')
  })
})

describe('buildPdf', () => {
  it('is a well-formed document whose cross-reference points at its objects', () => {
    const text = decode(buildPdf(sheetOf(5)))
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    // Each entry of the table is the offset where its object starts
    const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n/g)].map(match =>
      Number(match[1])
    )
    entries.forEach((offset, index) => {
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`)
    })
  })

  it('holds the title and the figures', () => {
    const text = decode(buildPdf(sheetOf(3)))
    expect(text).toContain('(Resumen semanal) Tj')
    expect(text).toContain('(Total) Tj')
  })

  it('goes to a second page when the days do not fit', () => {
    const text = decode(buildPdf(sheetOf(120)))
    expect(/\/Count (\d+)/.exec(text)?.[1]).not.toBe('1')
  })

  it('repeats the header on every page', () => {
    const text = decode(buildPdf(sheetOf(120)))
    const pages = Number(/\/Count (\d+)/.exec(text)?.[1])
    expect(text.split('(M\\351trica 0) Tj').length - 1).toBeGreaterThanOrEqual(pages)
  })

  it('splits many metrics in groups of columns instead of squeezing them', () => {
    const narrow = decode(buildPdf(sheetOf(3, 8)))
    const wide = decode(buildPdf(sheetOf(3, 17)))
    expect(Number(/\/Count (\d+)/.exec(wide)?.[1])).toBeGreaterThan(
      Number(/\/Count (\d+)/.exec(narrow)?.[1])
    )
  })

  it('cannot be made to close a string by the text of a name', () => {
    const hostile = { ...sheetOf(1), title: ') Tj ET 0 0 m 999 999 l S BT (' }
    const text = decode(buildPdf(hostile))
    expect(text).toContain('\\) Tj ET 0 0 m 999 999 l S BT \\(')
  })
})
