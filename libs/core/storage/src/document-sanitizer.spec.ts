import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'

import { DocumentSanitizing } from '@platform/core/storage'

import { isSanitizedDocumentType, sanitizeDocument } from './document-sanitizer'

const AUTHOR = 'Jane Q. Author'
const PROGRAM = 'Acme Writer 9'

async function pdfWithMetadata(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200]).drawText('hello')
  doc.addPage([200, 200])
  doc.setAuthor(AUTHOR)
  doc.setCreator(PROGRAM)
  doc.setProducer(PROGRAM)
  doc.setTitle('Private title')
  const xmp = doc.context.stream(`<x:xmpmeta><dc:creator>${AUTHOR}</dc:creator></x:xmpmeta>`, {
    Type: 'Metadata',
    Subtype: 'XML'
  })
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp))
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

// A text in a PDF is written as it is, between parentheses, or as UTF-16 in hex (what the setters of pdf-lib do)
const leaks = (pdf: Buffer, text: string): boolean =>
  pdf.includes(text) ||
  pdf.includes(Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase())

const OFFICE_RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://x/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://x/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>'

function docxWithMetadata(): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      '_rels/.rels': strToU8(OFFICE_RELS),
      'docProps/core.xml': strToU8(
        `<cp:coreProperties><dc:creator>${AUTHOR}</dc:creator><cp:lastModifiedBy>${AUTHOR}</cp:lastModifiedBy></cp:coreProperties>`
      ),
      'docProps/app.xml': strToU8(
        `<Properties><Application>${PROGRAM}</Application><Company>Acme</Company></Properties>`
      ),
      'docProps/custom.xml': strToU8(
        `<Properties><property name="who">${AUTHOR}</property></Properties>`
      ),
      'docProps/thumbnail.jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      'word/document.xml': strToU8('<w:document>the real text</w:document>')
    })
  )
}

describe('sanitizeDocument: a PDF', () => {
  it('loses the information dictionary and the XMP and keeps its pages', async () => {
    const dirty = await pdfWithMetadata()
    expect(dirty.includes(AUTHOR)).toBe(true)

    const result = await sanitizeDocument(dirty, 'application/pdf')

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    // Not even as an object that nothing points to
    expect(result.body.includes(AUTHOR)).toBe(false)
    expect(result.body.includes(PROGRAM)).toBe(false)
    const again = await PDFDocument.load(result.body, { updateMetadata: false })
    expect(again.getPageCount()).toBe(2)
    expect(again.getAuthor()).toBeUndefined()
    expect(again.catalog.get(PDFName.of('Metadata'))).toBeUndefined()
  })

  it('leaves a PDF that has nothing to cut, and one it cannot read, as it came', async () => {
    const first = await sanitizeDocument(await pdfWithMetadata(), 'application/pdf')
    if (first.kind !== 'sanitized') throw new Error('expected a cleaned pdf')

    expect(await sanitizeDocument(first.body, 'application/pdf')).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
    // Nothing in it to cut, or not readable at all: either way it is kept as it came
    expect((await sanitizeDocument(Buffer.from('%PDF-1.4 broken'), 'application/pdf')).kind).toBe(
      'untouched'
    )
  })

  it('drops the properties an incremental update left behind, and the XMP of a page', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([100, 100])
    doc.setAuthor('Alice Old')
    // A new information dictionary takes the place of the first, which stays in the file as an object nothing points to
    doc.context.trailerInfo.Info = doc.context.register(
      doc.context.obj({ Author: PDFString.of('Bob New') })
    )
    const xmp = doc.context.stream('<x:xmpmeta>Carol Page</x:xmpmeta>', {
      Type: 'Metadata',
      Subtype: 'XML'
    })
    page.node.set(PDFName.of('Metadata'), doc.context.register(xmp))
    const dirty = Buffer.from(await doc.save({ useObjectStreams: false }))
    expect(leaks(dirty, 'Alice Old')).toBe(true)

    const result = await sanitizeDocument(dirty, 'application/pdf')

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    for (const secret of ['Alice Old', 'Bob New', 'Carol Page']) {
      expect(leaks(result.body, secret)).toBe(false)
    }
    expect((await PDFDocument.load(result.body)).getPageCount()).toBe(1)
  })

  it('keeps the bookmarks and the comments of a PDF: an outline item and a text annotation look like an information dictionary but are not one', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([100, 100])
    doc.setAuthor(AUTHOR)
    const { context } = doc
    // An annotation with a Subject and a Contents, and an outline whose only item has a Title: no /Type, like an information dictionary
    const annotation = context.register(
      context.obj({
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        Subject: PDFString.of('customer note subject'),
        Contents: PDFString.of('customer note body')
      })
    )
    page.node.set(PDFName.of('Annots'), context.obj([annotation]))
    const outlines = context.nextRef()
    const item = context.nextRef()
    context.assign(outlines, context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }))
    context.assign(
      item,
      context.obj({
        Title: PDFString.of('Chapter one'),
        Parent: outlines,
        Dest: [page.ref, 'Fit']
      })
    )
    doc.catalog.set(PDFName.of('Outlines'), outlines)
    const dirty = Buffer.from(await doc.save({ useObjectStreams: false }))

    const result = await sanitizeDocument(dirty, 'application/pdf')

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    expect(leaks(result.body, AUTHOR)).toBe(false)
    const again = await PDFDocument.load(result.body)
    expect(again.catalog.get(PDFName.of('Outlines'))).toBeDefined()
    expect(result.body.includes('customer note body')).toBe(true)
    expect(result.body.includes('Chapter one')).toBe(true)
    expect(again.getPage(0).node.Annots()?.size()).toBe(1)
  })

  it('leaves a signed PDF as it came: rewriting it would break the signature', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    doc.setAuthor(AUTHOR)
    // The mark of a signature: a signature dictionary with its byte range
    doc.catalog.set(
      PDFName.of('Sig'),
      doc.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: '00' })
    )
    const signed = Buffer.from(await doc.save({ useObjectStreams: false }))
    expect(signed.includes('/ByteRange')).toBe(true)

    expect(await sanitizeDocument(signed, 'application/pdf')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('leaves a PDF that would be bigger than the limit as it came', async () => {
    expect(await sanitizeDocument(await pdfWithMetadata(), 'application/pdf', 10)).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })
})

describe.each([
  ['docx', DocumentSanitizing.DOCX_CONTENT_TYPE],
  ['xlsx', DocumentSanitizing.XLSX_CONTENT_TYPE]
])('sanitizeDocument: a %s', (_name, contentType) => {
  it('is written again with empty properties, no thumbnail and the same content', async () => {
    const dirty = docxWithMetadata()

    const result = await sanitizeDocument(dirty, contentType)

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    const parts = unzipSync(new Uint8Array(result.body))
    const all = Object.values(parts)
      .map(part => strFromU8(part))
      .join('')
    expect(all.includes(AUTHOR)).toBe(false)
    expect(all.includes(PROGRAM)).toBe(false)
    expect(parts['docProps/thumbnail.jpeg']).toBeUndefined()
    expect(strFromU8(parts['_rels/.rels'] as Uint8Array)).not.toContain('thumbnail')
    expect(strFromU8(parts['_rels/.rels'] as Uint8Array)).toContain('docProps/core.xml')
    expect(strFromU8(parts['word/document.xml'] as Uint8Array)).toBe(
      '<w:document>the real text</w:document>'
    )
    // The first part stays first, as the format wants
    expect(Object.keys(parts)[0]).toBe('[Content_Types].xml')
  })

  it('does not write the day it ran into the file: two runs are the same bytes', async () => {
    const one = await sanitizeDocument(docxWithMetadata(), contentType)
    const two = await sanitizeDocument(docxWithMetadata(), contentType)
    if (one.kind !== 'sanitized' || two.kind !== 'sanitized') throw new Error('expected cleaned')
    expect(one.body.equals(two.body)).toBe(true)
  })

  it('writes the core properties of a package that keeps them in another part, and a thumbnail relationship spelled another way', async () => {
    const rels =
      "<Relationships xmlns='x'><Relationship Id='a' Type='http://x/package/2006/relationships/metadata/core-properties' Target='/package/services/metadata/core-properties/abc.psmdcp'></Relationship>" +
      "<Relationship Id='b' Type='http://x/package/2006/relationships/metadata/thumbnail' Target='docProps/thumb.png' /></Relationships>"
    const dirty = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        '_rels/.rels': strToU8(rels),
        'package/services/metadata/core-properties/abc.psmdcp': strToU8(
          `<cp:coreProperties><dc:creator>${AUTHOR}</dc:creator></cp:coreProperties>`
        ),
        'docProps/thumb.png': new Uint8Array([1, 2, 3]),
        'word/document.xml': strToU8('<w:document/>')
      })
    )

    const result = await sanitizeDocument(dirty, contentType)

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    const parts = unzipSync(new Uint8Array(result.body))
    expect(
      Object.values(parts)
        .map(part => strFromU8(part))
        .join('')
        .includes(AUTHOR)
    ).toBe(false)
    expect(parts['docProps/thumb.png']).toBeUndefined()
    expect(strFromU8(parts['_rels/.rels'] as Uint8Array)).not.toContain('thumbnail')
  })

  it('keeps a package whose relationships are hostile, and does it fast: a list of elements that never close', async () => {
    const hostile = (copies: number): Buffer =>
      Buffer.from(
        zipSync({
          '[Content_Types].xml': strToU8('<Types/>'),
          '_rels/.rels': strToU8('<Relationship '.repeat(copies)),
          'docProps/core.xml': strToU8(`<cp:coreProperties>${AUTHOR}</cp:coreProperties>`)
        })
      )
    // Past the cap of the list, and under it (the walk itself must not grow with the square of the size)
    for (const copies of [40_000, 4_000]) {
      const started = Date.now()
      const result = await sanitizeDocument(hostile(copies), contentType)
      expect(result).toEqual({ kind: 'untouched', why: 'not_cleanable' })
      expect(Date.now() - started).toBeLessThan(1000)
    }
  })

  it('reads a relationship written with a closing tag and one of the container, and keeps the others', async () => {
    const rels =
      '<Relationships xmlns="x"><Relationship Id="a" Type="http://x/metadata/thumbnail" Target="docProps/t.png"></Relationship>' +
      '<Relationship Id="b" Type="http://x/officeDocument" Target="word/document.xml"/></Relationships>'
    const dirty = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        '_rels/.rels': strToU8(rels),
        'docProps/t.png': new Uint8Array([1]),
        'word/document.xml': strToU8('<w:document/>')
      })
    )

    const result = await sanitizeDocument(dirty, contentType)

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    const kept = strFromU8(unzipSync(new Uint8Array(result.body))['_rels/.rels'] as Uint8Array)
    expect(kept).toBe(
      '<Relationships xmlns="x"><Relationship Id="b" Type="http://x/officeDocument" Target="word/document.xml"/></Relationships>'
    )
  })

  it('keeps a package whose part is longer than the size its zip declares: it would be written cut short', async () => {
    const dirty = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'docProps/core.xml': strToU8(`<cp:coreProperties>${AUTHOR}</cp:coreProperties>`),
        'word/document.xml': strToU8(
          '<w:document>'.concat('the real text '.repeat(50), '</w:document>')
        )
      })
    )
    // The size that the central directory declares for the last part, made smaller than the data
    const central = dirty.lastIndexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      dirty.lastIndexOf('word/document.xml')
    )
    dirty.writeUInt32LE(5, central + 24)

    expect(await sanitizeDocument(dirty, contentType)).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('is left as it came when it is cleaned already, is not a package or is too big when opened', async () => {
    const first = await sanitizeDocument(docxWithMetadata(), contentType)
    if (first.kind !== 'sanitized') throw new Error('expected cleaned')
    expect(await sanitizeDocument(first.body, contentType)).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
    expect(await sanitizeDocument(Buffer.from('PK not really a zip'), contentType)).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
    const bomb = Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8('<Types/>'),
        'big.bin': new Uint8Array(DocumentSanitizing.MAX_UNCOMPRESSED_BYTES + 1)
      })
    )
    expect(await sanitizeDocument(bomb, contentType)).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })
})

describe('isSanitizedDocumentType', () => {
  it('is true for a PDF, a docx and an xlsx and false for anything else', () => {
    expect(isSanitizedDocumentType('application/pdf')).toBe(true)
    expect(isSanitizedDocumentType(DocumentSanitizing.DOCX_CONTENT_TYPE)).toBe(true)
    expect(isSanitizedDocumentType(DocumentSanitizing.XLSX_CONTENT_TYPE)).toBe(true)
    expect(isSanitizedDocumentType('text/csv')).toBe(false)
    expect(isSanitizedDocumentType('image/png')).toBe(false)
  })
})
