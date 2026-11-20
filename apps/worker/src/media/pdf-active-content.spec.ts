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

  it('ends a name at a NUL, which is white space in a PDF', () => {
    expect(findActivePdfNames(pdf('1 0 obj << /JS\u0000(code) >> endobj'))).toEqual(['JS'])
    expect(findActivePdfNames(pdf('1 0 obj << /JavaScript\u0000 2 0 R >> endobj'))).toEqual([
      'JavaScript'
    ])
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

  // Linear, not quadratic: the time of a file eight times larger is about eight times the time, never sixty-four. An absolute limit in
  // milliseconds flakes on a shared runner (3152 ms against 3000 once), so the cost is measured against the same function on a smaller
  // file of the same kind, the best of three runs each, and the ratio is held to four times the linear one, and the large file has a loose absolute ceiling for a scan that is linear but uniformly slow.
  describe('is linear in the size of the file', () => {
    const SMALL = 1024 * 1024
    const FACTOR = 8
    const LINEAR_MARGIN = 4
    const SLOWEST_LARGE_NS = 15_000_000_000
    const bestOf = (bytes: Uint8Array): number => {
      let best = Number.POSITIVE_INFINITY
      for (let run = 0; run < 3; run += 1) {
        const started = process.hrtime.bigint()
        findActivePdfNames(bytes)
        best = Math.min(best, Number(process.hrtime.bigint() - started))
      }
      return best
    }

    it.each([
      ['no names at all', (size: number) => Buffer.alloc(size, 0x20)],
      ['nothing but names', (size: number) => Buffer.from('/a'.repeat(size / 2))]
    ])(
      'for a file with %s',
      (_name, make) => {
        findActivePdfNames(make(SMALL)) // warm up the engine at the measured size before measuring
        const small = bestOf(make(SMALL))
        const large = bestOf(make(SMALL * FACTOR))
        expect(findActivePdfNames(make(SMALL))).toEqual([])
        expect(large / small).toBeLessThan(FACTOR * LINEAR_MARGIN)
        expect(large).toBeLessThan(SLOWEST_LARGE_NS)
      },
      30_000
    )
  })
})
