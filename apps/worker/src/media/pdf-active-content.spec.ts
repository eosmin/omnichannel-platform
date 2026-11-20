import {
  type PDFArray,
  type PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFRef,
  PDFString
} from 'pdf-lib'

import { inspectPdf } from './pdf-active-content'

// TAX-436: a PDF kept as the receipt of a transaction must not carry anything that runs when it is opened.
// The documents are built with the library that reads them, then hostile bytes are cut into them.
type Edit = (doc: PDFDocument, catalog: PDFDict) => void

async function build(edit?: Edit, objectStreams = false): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  edit?.(doc, doc.catalog)
  return Buffer.from(await doc.save({ useObjectStreams: objectStreams, addDefaultPage: false }))
}

const action = (doc: PDFDocument, type: string, extra: Record<string, string> = {}): PDFDict =>
  doc.context.obj({ S: type, ...extra })
const withOpenAction =
  (make: (doc: PDFDocument) => PDFDict | PDFArray | PDFRef): Edit =>
  (doc, catalog) => {
    catalog.set(PDFName.of('OpenAction'), make(doc))
  }
const javascript = withOpenAction(doc =>
  doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })
)
const names = async (bytes: Buffer): Promise<string[]> => (await inspectPdf(bytes)).names
const CLEAN = { names: [], unreadable: null }
const replace = (bytes: Buffer, from: string, to: string): Buffer =>
  Buffer.from(bytes.toString('latin1').replace(from, to), 'latin1')

describe('inspectPdf', () => {
  it.each([false, true])('lets a plain PDF through (object streams: %s)', async objectStreams => {
    expect(await inspectPdf(await build(undefined, objectStreams))).toEqual(CLEAN)
  })

  it.each([false, true])(
    'finds the /OpenAction that runs JavaScript, in the clear or in an object stream (%s)',
    async objectStreams => {
      expect(await names(await build(javascript, objectStreams))).toEqual(
        expect.arrayContaining(['OpenAction', 'JavaScript', 'JS'])
      )
    }
  )

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
  ])('finds the name /%s', async name => {
    const bytes = await build((_doc, catalog) => {
      catalog.set(PDFName.of(name), PDFNumber.of(1))
    })
    expect((await inspectPdf(bytes)).names).toEqual([name])
  })

  it('finds a name written with hex escapes, which a reader reads as the same name', async () => {
    const plain = await build((_doc, catalog) =>
      catalog.set(PDFName.of('ZZZZZZZZ'), PDFNumber.of(1))
    )
    expect(await names(replace(plain, '/ZZZZZZZZ', '/J#61vaScript'))).toContain('JavaScript')
  })

  it('does not take a longer name for a forbidden one', async () => {
    const bytes = await build((_doc, catalog) => {
      catalog.set(PDFName.of('JSON'), PDFNumber.of(1))
      catalog.set(PDFName.of('AAA'), PDFNumber.of(1))
      catalog.set(PDFName.of('OpenActions'), PDFNumber.of(1))
    })
    expect(await inspectPdf(bytes)).toEqual(CLEAN)
  })

  describe('/OpenAction', () => {
    it('does not refuse a destination (Word, LaTeX and Acrobat write them)', async () => {
      const bytes = await build(
        withOpenAction(doc => doc.context.obj([doc.getPage(0).ref, PDFName.of('Fit')]))
      )
      expect(await inspectPdf(bytes)).toEqual(CLEAN)
    })

    it('does not refuse a destination reached through a reference', async () => {
      const bytes = await build((doc, catalog) => {
        const destination = doc.context.register(
          doc.context.obj([doc.getPage(0).ref, PDFName.of('Fit')])
        )
        catalog.set(PDFName.of('OpenAction'), destination)
      })
      expect(await inspectPdf(bytes)).toEqual(CLEAN)
    })

    it('refuses an action that opens a link, and a value that is not a destination or an action', async () => {
      const link = await build(
        withOpenAction(doc => action(doc, 'URI', { URI: 'http://example.test' }))
      )
      expect(await names(link)).toContain('OpenAction')
      const odd = await build((_doc, catalog) =>
        catalog.set(PDFName.of('OpenAction'), PDFString.of('x'))
      )
      expect(await names(odd)).toContain('OpenAction')
    })

    it('refuses an action reached through a reference', async () => {
      const bytes = await build((doc, catalog) => {
        const ref = doc.context.register(action(doc, 'URI', { URI: 'http://example.test' }))
        catalog.set(PDFName.of('OpenAction'), ref)
      })
      expect(await names(bytes)).toContain('OpenAction')
    })
  })

  describe('what cannot be proven is refused', () => {
    it('refuses an encrypted file', async () => {
      const plain = await build()
      const bytes = replace(
        plain,
        '/Root',
        '/Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (x) /P 0 >> /Root'
      )
      expect((await inspectPdf(bytes)).unreadable).toMatch(/^(encrypted|not_readable)$/)
    })

    it('refuses bytes that are not a PDF, and a truncated one', async () => {
      expect(await inspectPdf(Buffer.from('%PDF-1.4 nothing here'))).toMatchObject({
        unreadable: 'not_readable'
      })
      const whole = await build(undefined, true)
      expect(await inspectPdf(whole.subarray(0, Math.floor(whole.length / 2)))).toMatchObject({
        unreadable: 'not_readable'
      })
    })

    it('does not let through an object stream that is not called one', async () => {
      const bytes = await build(javascript, true)
      // The catalog sits in an object stream; the word that names it is cut out
      const hidden = replace(bytes, '/Type /ObjStm', '/Type /ObjStx')
      const inspected = await inspectPdf(hidden)
      expect(inspected.names.includes('OpenAction') || inspected.unreadable !== null).toBe(true)
    })

    it('does not skip a stream keyword that follows a NUL, which is white space in a PDF', async () => {
      const bytes = await build(javascript, true)
      const odd = replace(bytes, '>>\nstream', '>>\u0000stream')
      const inspected = await inspectPdf(odd)
      expect(inspected.names.includes('OpenAction') || inspected.unreadable !== null).toBe(true)
    })

    it('is bounded in time for a file of nothing but objects', async () => {
      const filler = Buffer.from('1 0 obj null endobj\n'.repeat(120_000))
      const bytes = Buffer.concat([await build(), filler])
      const started = Date.now()
      await inspectPdf(bytes)
      expect(Date.now() - started).toBeLessThan(8000)
    })

    it('is bounded in time for many stream keywords and no object', async () => {
      const bytes = Buffer.concat([
        await build(),
        Buffer.from(' '.repeat(5_000_000) + 'stream\n'.repeat(20_000))
      ])
      const started = Date.now()
      await inspectPdf(bytes)
      expect(Date.now() - started).toBeLessThan(8000)
    })
  })

  it('does not look for names in the data of a stream (a binary file passes)', async () => {
    const bytes = await build(doc => {
      const stream = doc.context.stream(Buffer.from('/JS /AA /OpenAction /JavaScript /Launch'))
      doc.context.register(stream)
    })
    expect(await inspectPdf(bytes)).toEqual(CLEAN)
  })
})
