import { findActivePdfNames } from './pdf-active-content'

// TAX-436: a PDF kept as the receipt of a transaction must not carry, in the clear, anything that runs when it is
// opened. Best effort, not a sandbox: see the header of `pdf-active-content.ts`.
const pdf = (body: string): Buffer => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, 'latin1')

describe('findActivePdfNames', () => {
  it('lets a plain PDF through', () => {
    const bytes = pdf(
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj'
    )
    expect(findActivePdfNames(bytes)).toEqual([])
  })

  it('finds the /OpenAction that runs JavaScript when the file is opened (the case of TAX-436)', () => {
    const bytes = pdf(
      '1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj'
    )
    expect(findActivePdfNames(bytes)).toEqual(expect.arrayContaining(['JavaScript', 'JS']))
  })

  it.each(['JavaScript', 'JS', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'RichMedia'])(
    'finds the name /%s',
    name => {
      expect(findActivePdfNames(pdf(`1 0 obj << /${name} 2 0 R >> endobj`))).toEqual([name])
    }
  )

  it('finds a name written with hex escapes, which a reader reads as the same name', () => {
    expect(findActivePdfNames(pdf('1 0 obj << /J#61vaScript 2 0 R >> endobj'))).toEqual([
      'JavaScript'
    ])
    expect(findActivePdfNames(pdf('1 0 obj << /#4A#53 (x) >> endobj'))).toEqual(['JS'])
  })

  it('does not take a longer name for a forbidden one', () => {
    expect(
      findActivePdfNames(pdf('1 0 obj << /JSON 1 /JavaScripts 2 /LaunchX 3 >> endobj'))
    ).toEqual([])
  })

  it('does not refuse an /OpenAction that is a destination (Word, LaTeX and Acrobat write them)', () => {
    expect(
      findActivePdfNames(pdf('1 0 obj << /Type /Catalog /OpenAction [3 0 R /Fit] >> endobj'))
    ).toEqual([])
    expect(
      findActivePdfNames(pdf('1 0 obj << /OpenAction 5 0 R >> endobj\n5 0 obj [3 0 R /XYZ] endobj'))
    ).toEqual([])
  })

  it('takes milliseconds for a file of 10 MB with no names, and for one made only of names', () => {
    const quiet = Buffer.alloc(10 * 1024 * 1024, 0x20)
    const names = Buffer.from('/a'.repeat(5 * 1024 * 1024))
    const started = Date.now()
    expect(findActivePdfNames(quiet)).toEqual([])
    expect(findActivePdfNames(names)).toEqual([])
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
