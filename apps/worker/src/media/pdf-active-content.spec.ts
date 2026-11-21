import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PdfInspection } from '@platform/core/storage'

import { findActivePdfNames, newPdfScanWork, type PdfScanWork } from './pdf-active-content'

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

  // Linear, not quadratic, counted as WORK and not as time: a time (even a ratio of two times) flakes on a shared runner (3152 ms against
  // 3000 once; a ratio of 43.9 against 32 the next time), while the counters of the scan are the same on every machine. `PdfScanWork` counts
  // each pass over the text, the characters it examined and the names it read; every traversal of the text goes through the one
  // function that counts, so a second pass (or one per name) is seen as work that grows faster than the file.
  describe('is linear in the size of the file', () => {
    const SMALL = 1024 * 1024
    const FACTOR = 8
    const make: [string, (size: number) => Buffer][] = [
      ['no names at all', size => Buffer.alloc(size, 0x20)],
      ['nothing but names', size => Buffer.from('/a'.repeat(size / 2))],
      ['names that are active', size => Buffer.from('/JS '.repeat(size / 4))]
    ]
    const work = (bytes: Buffer): PdfScanWork => {
      const counted = newPdfScanWork()
      findActivePdfNames(bytes, counted)
      return counted
    }

    it.each(make)('reads the text once and each name once, for a file with %s', (_name, build) => {
      for (const size of [SMALL, SMALL * FACTOR]) {
        const counted = work(build(size))
        expect(counted.passes).toBe(1)
        expect(counted.charsExamined).toBe(size)
        // A name takes at least two characters ('/' and one more), so the names read cannot be more than half of the file
        expect(counted.namesRead).toBeLessThanOrEqual(size / 2)
      }
    })

    it.each(make)(
      'does eight times the work for a file eight times larger, with %s',
      (_name, build) => {
        const small = work(build(SMALL))
        const large = work(build(SMALL * FACTOR))
        expect(large.charsExamined).toBe(small.charsExamined * FACTOR)
        expect(large.namesRead).toBeLessThanOrEqual(small.namesRead * FACTOR)
        expect(large.passes).toBe(small.passes)
        expect(large.charsDecoded).toBeLessThanOrEqual(small.charsDecoded * FACTOR)
      }
    )

    it('makes the text in the one counted pass, and never anywhere else', () => {
      const source = readFileSync(join(__dirname, 'pdf-active-content.ts'), 'utf8')
      // The text is made from the bytes once, inside the generator that counts, and is scanned by its one `matchAll`: no other function
      // holds it, so no other function can traverse it unseen
      expect(source.match(/\.toString\(\s*PdfInspection\.TEXT_ENCODING\s*\)/g)).toHaveLength(1)
      expect(source.match(/matchAll\(/g)).toHaveLength(1)
      expect(source.match(/TEXT_ENCODING/g)).toHaveLength(1)
    })

    // What a regular expression does inside the pass is not counted: a nested quantifier (`(a+)+`, `(a*)*`, `(.*)*`) is the shape of the
    // ones that backtrack without end, so the patterns of the scan have none
    it.each([
      ['the name', PdfInspection.NAME_PATTERN],
      ['the hex escape', PdfInspection.HEX_ESCAPE_PATTERN]
    ])('has no nested quantifier in the pattern of %s', (_what, pattern) => {
      expect(pattern).not.toMatch(/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/)
      expect(pattern).not.toMatch(/[+*}]\?/)
    })

    // A scan that is linear but uniformly slow is not a matter of work but of time: the ceiling is a safety net far above any runner
    it.each(make)(
      'finishes a file of 10 MB in a time no runner passes, with %s',
      (_name, build) => {
        const bytes = build(10 * 1024 * 1024)
        const started = Date.now()
        findActivePdfNames(bytes)
        expect(Date.now() - started).toBeLessThan(60_000)
      },
      90_000
    )
  })
})
