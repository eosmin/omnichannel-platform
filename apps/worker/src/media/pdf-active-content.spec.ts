import { deflateSync } from 'node:zlib'

import { findPdfActiveContent } from './pdf-active-content'

// TAX-436: a PDF kept as the receipt of a transaction must not carry anything that runs when it is opened
const pdf = (body: string): Buffer => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, 'latin1')

const CLEAN = pdf(
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj'
)

describe('findPdfActiveContent', () => {
  it('lets a plain PDF through', () => {
    expect(findPdfActiveContent(CLEAN)).toEqual([])
  })

  it('finds the /OpenAction that runs JavaScript when the file is opened', () => {
    const bytes = pdf(
      '1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj'
    )
    expect(findPdfActiveContent(bytes)).toEqual(
      expect.arrayContaining(['OpenAction', 'JavaScript', 'JS'])
    )
  })

  it.each(['JavaScript', 'JS', 'OpenAction', 'AA', 'Launch', 'EmbeddedFile'])(
    'finds the name /%s',
    name => {
      expect(findPdfActiveContent(pdf(`1 0 obj << /${name} 2 0 R >> endobj`))).toEqual([name])
    }
  )

  it('finds a name written with hex escapes, which a PDF reader reads as the same name', () => {
    expect(findPdfActiveContent(pdf('1 0 obj << /J#61vaScript 2 0 R >> endobj'))).toEqual([
      'JavaScript'
    ])
    expect(findPdfActiveContent(pdf('1 0 obj << /#4Fpen#41ction 2 0 R >> endobj'))).toEqual([
      'OpenAction'
    ])
  })

  it('does not take a longer name for a forbidden one', () => {
    expect(findPdfActiveContent(pdf('1 0 obj << /JSON 1 /AAA 2 /OpenActions 3 >> endobj'))).toEqual(
      []
    )
  })

  it('finds a name hidden in a compressed stream (an object stream)', () => {
    const inner = Buffer.from('<< /Type /Catalog /OpenAction << /S /JavaScript /JS (x) >> >>')
    const compressed = deflateSync(inner)
    const bytes = Buffer.concat([
      Buffer.from(
        '%PDF-1.5\n1 0 obj << /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode >>\nstream\n'
      ),
      compressed,
      Buffer.from('\nendstream endobj\n%%EOF\n')
    ])
    expect(findPdfActiveContent(bytes)).toEqual(
      expect.arrayContaining(['OpenAction', 'JavaScript'])
    )
  })

  it('does not inflate a picture stream and skips a stream that would inflate past the limit', () => {
    const big = deflateSync(Buffer.alloc(10 * 1024 * 1024, 0x20))
    const bytes = Buffer.concat([
      Buffer.from('%PDF-1.5\n1 0 obj << /Subtype /Image /Filter /FlateDecode >>\nstream\n'),
      big,
      Buffer.from('\nendstream endobj\n2 0 obj << /Filter /FlateDecode >>\nstream\n'),
      big,
      Buffer.from('\nendstream endobj\n%%EOF\n')
    ])
    expect(findPdfActiveContent(bytes)).toEqual([])
  })
})
