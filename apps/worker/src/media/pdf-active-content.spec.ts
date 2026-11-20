import { deflateSync } from 'node:zlib'

import { inspectPdf } from './pdf-active-content'

// TAX-436: a PDF kept as the receipt of a transaction must not carry anything that runs when it is opened
const pdf = (body: string): Buffer => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, 'latin1')
const names = (bytes: Buffer): string[] => inspectPdf(bytes).names
const CLEAN_RESULT = { names: [], unreadable: null }

// An object stream: the objects deflated, the way a PDF 1.5 hides its catalog from a plain look
const objectStream = (
  inner: string,
  options: { dictionary?: string; level?: number; length?: boolean } = {}
): Buffer => {
  const data = deflateSync(Buffer.from(inner), { level: options.level ?? 6 })
  const length = options.length === true ? ` /Length ${data.length}` : ''
  const dictionary =
    options.dictionary ?? `<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode${length} >>`
  return Buffer.concat([
    Buffer.from(`%PDF-1.5\n7 0 obj ${dictionary}\nstream\n`),
    data,
    Buffer.from('\nendstream endobj\n%%EOF\n')
  ])
}
const HOSTILE = '<< /Type /Catalog /OpenAction << /S /JavaScript /JS (x) >> >>'

const CLEAN = pdf(
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj'
)

describe('inspectPdf', () => {
  it('lets a plain PDF through', () => {
    expect(inspectPdf(CLEAN)).toEqual(CLEAN_RESULT)
  })

  it('finds the /OpenAction that runs JavaScript when the file is opened', () => {
    const bytes = pdf(
      '1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj'
    )
    expect(names(bytes)).toEqual(expect.arrayContaining(['OpenAction', 'JavaScript', 'JS']))
  })

  it.each([
    'JavaScript',
    'JS',
    'AA',
    'Launch',
    'EmbeddedFile',
    'EF',
    'EmbeddedFiles',
    'FileAttachment',
    'SubmitForm',
    'ResetForm',
    'ImportData',
    'GoToR',
    'GoToE',
    'GoToDp',
    'GoTo3DView',
    'Named',
    'Hide',
    'SetOCGState',
    'Thread',
    'Screen',
    'RichMedia',
    'RichMediaContent',
    'RichMediaActivation',
    'XFA',
    'AcroForm',
    'Rendition',
    'Movie',
    'Sound',
    '3D'
  ])('finds the name /%s', name => {
    expect(inspectPdf(pdf(`1 0 obj << /${name} 2 0 R >> endobj`))).toEqual({
      names: [name],
      unreadable: null
    })
  })

  it('finds a name written with hex escapes, which a PDF reader reads as the same name', () => {
    expect(names(pdf('1 0 obj << /J#61vaScript 2 0 R >> endobj'))).toEqual(['JavaScript'])
    expect(
      names(pdf('1 0 obj << /#4Fpen#41ction << /S /URI /URI (http://x) >> >> endobj'))
    ).toEqual(['OpenAction'])
  })

  it('does not refuse an /OpenAction that is a destination (Word, LaTeX and Acrobat write them)', () => {
    expect(inspectPdf(pdf('1 0 obj << /Type /Catalog /OpenAction [3 0 R /Fit] >> endobj'))).toEqual(
      CLEAN_RESULT
    )
    expect(
      inspectPdf(
        pdf('1 0 obj << /OpenAction 5 0 R >> endobj\n5 0 obj [3 0 R /XYZ 0 792 null] endobj')
      )
    ).toEqual(CLEAN_RESULT)
  })

  it('refuses an /OpenAction whose value is an action that opens a link, a reference it cannot find or something unknown', () => {
    expect(names(pdf('1 0 obj << /OpenAction << /S /URI /URI (http://x) >> >> endobj'))).toEqual([
      'OpenAction'
    ])
    expect(names(pdf('1 0 obj << /OpenAction 9 0 R >> endobj'))).toEqual(['OpenAction'])
    expect(names(pdf('1 0 obj << /OpenAction (text) >> endobj'))).toEqual(['OpenAction'])
  })

  it('does not take a longer name for a forbidden one', () => {
    expect(inspectPdf(pdf('1 0 obj << /JSON 1 /AAA 2 /OpenActions 3 >> endobj'))).toEqual(
      CLEAN_RESULT
    )
  })

  describe('object streams', () => {
    it('finds a name hidden inside one', () => {
      expect(names(objectStream(HOSTILE))).toEqual(
        expect.arrayContaining(['OpenAction', 'JavaScript', 'JS'])
      )
    })

    it('finds it when the dictionary says the stream is a picture (a reader ignores that key)', () => {
      const bytes = objectStream(HOSTILE, {
        dictionary: '<< /Type /ObjStm /Subtype /Image /N 1 /First 5 /Filter /FlateDecode >>'
      })
      expect(names(bytes)).toContain('OpenAction')
    })

    it('finds it when the type is written with hex escapes', () => {
      const bytes = objectStream(HOSTILE, {
        dictionary: '<< /Type /Obj#53tm /N 1 /First 5 /Filter /FlateDecode >>'
      })
      expect(names(bytes)).toContain('OpenAction')
    })

    it('uses the /Length when the data holds the word endstream', () => {
      const bytes = objectStream('<< /Note (endstream) /OpenAction << /S /JavaScript >> >>', {
        level: 0,
        length: true
      })
      expect(names(bytes)).toContain('OpenAction')
    })

    it('refuses one that passes the size limit instead of letting it through', () => {
      const big = objectStream(`${' '.repeat(9 * 1024 * 1024)}${HOSTILE}`)
      expect(inspectPdf(big)).toMatchObject({ unreadable: 'object_stream_unreadable' })
    })

    it('refuses one that does not inflate', () => {
      const bytes = Buffer.from(
        '%PDF-1.5\n7 0 obj << /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode >>\nstream\nnot deflate at all\nendstream endobj\n'
      )
      expect(inspectPdf(bytes)).toMatchObject({ unreadable: 'object_stream_unreadable' })
    })

    it('refuses one that never ends', () => {
      const bytes = Buffer.from(
        '%PDF-1.5\n7 0 obj << /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode >>\nstream\nxxxx'
      )
      expect(inspectPdf(bytes)).toMatchObject({ unreadable: 'object_stream_unreadable' })
    })

    it('does not let through a file whose object stream marker was hidden from its dictionary', () => {
      // The word obj inside a string of the dictionary moves the start of the slice that is read
      const bytes = objectStream(HOSTILE, {
        dictionary: '<< /Type /ObjStm /Filter /FlateDecode /Note (1 0 obj) /N 1 /First 5 >>'
      })
      const inspected = inspectPdf(bytes)
      expect(inspected.names.length > 0 || inspected.unreadable !== null).toBe(true)
    })

    it('refuses a chain of filters or a predictor, which it does not undo', () => {
      const chain = objectStream(HOSTILE, {
        dictionary: '<< /Type /ObjStm /N 1 /First 5 /Filter [/FlateDecode /FlateDecode] >>'
      })
      expect(inspectPdf(chain)).toMatchObject({ unreadable: 'unsupported_filter' })
      const predictor = objectStream(HOSTILE, {
        dictionary:
          '<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 1 >> >>'
      })
      expect(inspectPdf(predictor)).toMatchObject({ unreadable: 'unsupported_filter' })
    })

    it('reads an object stream that is not compressed', () => {
      const bytes = Buffer.from(
        `%PDF-1.5\n7 0 obj << /Type /ObjStm /N 1 /First 5 >>\nstream\n${HOSTILE}\nendstream endobj\n`
      )
      expect(names(bytes)).toContain('OpenAction')
    })

    it('takes an indirect /Length for what it is (it is not the digits before the reference)', () => {
      const data = deflateSync(Buffer.from(HOSTILE))
      const bytes = Buffer.concat([
        Buffer.from(
          '%PDF-1.5\n7 0 obj << /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Length 10 0 R >>\nstream\n'
        ),
        data,
        Buffer.from('\nendstream endobj\n')
      ])
      expect(names(bytes)).toContain('OpenAction')
    })

    it('lets through a file that is nothing but the word stream when it holds no object stream, quickly', () => {
      const bytes = Buffer.from(`%PDF-1.5\n1 0 obj\n${'stream\n'.repeat(30_000)}`)
      const started = Date.now()
      expect(inspectPdf(bytes)).toEqual(CLEAN_RESULT)
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it('refuses a file with too many of them', () => {
      const one = objectStream('<< /Type /Catalog >>').toString('latin1').replace('%PDF-1.5\n', '')
      const bytes = Buffer.from(`%PDF-1.5\n${one.repeat(51)}`, 'latin1')
      expect(inspectPdf(bytes)).toMatchObject({ unreadable: 'too_many_object_streams' })
    })

    it('is bounded in time when the file has no obj to find and thousands of stream keywords', () => {
      const filler = ' '.repeat(5 * 1024 * 1024)
      const bytes = Buffer.from(`%PDF-1.5\n/Type /ObjStm ${filler}${'stream\n'.repeat(19_000)}`)
      const started = Date.now()
      const result = inspectPdf(bytes)
      expect(Date.now() - started).toBeLessThan(3000)
      expect(result.unreadable).not.toBeNull()
    })

    it('is bounded in time when there are millions of endobj before the streams', () => {
      const bytes = Buffer.from(
        `%PDF-1.5\n/Type /ObjStm ${'endobj '.repeat(600_000)}${'stream\n'.repeat(15_000)}`
      )
      const started = Date.now()
      expect(inspectPdf(bytes).unreadable).not.toBeNull()
      expect(Date.now() - started).toBeLessThan(3000)
    })

    it('refuses a file with a decoy stream that tries to match the count of object streams', () => {
      const data = deflateSync(Buffer.from(HOSTILE))
      const real = Buffer.concat([
        Buffer.from(
          '%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /FlateDecode /N 1 /First 5 >> stream\r'
        ),
        data,
        Buffer.from('\nendstream endobj\n')
      ])
      const decoy = Buffer.from(
        '2 0 obj << /Foo 1 >> stream\n' + 'x'.repeat(8) + '\nendstream endobj\n%%EOF\n',
        'latin1'
      )
      const inspected = inspectPdf(Buffer.concat([real, decoy]))
      expect(inspected.names.includes('OpenAction') || inspected.unreadable !== null).toBe(true)
    })

    it('reads an object stream whose keyword is followed by a lone CR', () => {
      const data = deflateSync(Buffer.from(HOSTILE))
      const bytes = Buffer.concat([
        Buffer.from(
          '%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /FlateDecode /N 1 /First 5 >>\nstream\r'
        ),
        data,
        Buffer.from('\nendstream endobj\n')
      ])
      expect(names(bytes)).toContain('OpenAction')
    })

    it('still reads the real object stream that lies inside the range another /Length declares', () => {
      const real = deflateSync(Buffer.from(HOSTILE))
      const inner = Buffer.concat([
        Buffer.from('\n9 0 obj << /Type /ObjStm /Filter /FlateDecode /N 1 /First 5 >>\nstream\n'),
        real,
        Buffer.from('\nendstream endobj\n')
      ])
      const bytes = Buffer.concat([
        Buffer.from(
          `%PDF-1.5\n1 0 obj << /Type /ObjStm /N 0 /First 0 /Length ${inner.length} >>\nstream\n`
        ),
        inner,
        Buffer.from('\nendstream endobj\n')
      ])
      const inspected = inspectPdf(bytes)
      expect(inspected.names.includes('OpenAction') || inspected.unreadable !== null).toBe(true)
    })

    it('refuses a stream keyword it cannot recognise once the file has an object stream', () => {
      const bytes = Buffer.from(
        '%PDF-1.5\n1 0 obj << /Type /ObjStm /N 0 /First 0 >>\nstream\n\nendstream endobj\n garbage >> stream\n abc'
      )
      expect(inspectPdf(bytes)).toMatchObject({ unreadable: 'unrecognised_stream' })
    })

    it('refuses a file with more names than it will walk', () => {
      const bytes = Buffer.from(`%PDF-1.4\n${'/a'.repeat(1_100_000)}`)
      expect(inspectPdf(bytes)).toMatchObject({ unreadable: 'too_many_names' })
    })

    it('does not read a stream that is not an object stream (a big picture passes)', () => {
      const bytes = Buffer.concat([
        Buffer.from('%PDF-1.5\n1 0 obj << /Subtype /Image /Filter /FlateDecode >>\nstream\n'),
        deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20)),
        Buffer.from('\nendstream endobj\n%%EOF\n')
      ])
      expect(inspectPdf(bytes)).toEqual(CLEAN_RESULT)
    })
  })

  it('refuses an encrypted file: what it carries cannot be read', () => {
    expect(inspectPdf(pdf('trailer << /Encrypt 9 0 R /Root 1 0 R >>'))).toMatchObject({
      unreadable: 'encrypted'
    })
  })
})
