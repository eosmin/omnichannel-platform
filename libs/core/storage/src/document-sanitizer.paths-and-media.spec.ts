import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
import sharp from 'sharp'

import { DocumentSanitizing } from '@platform/core/storage'

import { sanitizeDocumentInline } from './document-sanitizer'

// Step 7.3, `office-user-paths-and-embedded-media`: the paths of the author's machine in a docx or an xlsx, and the photos inside a docx, an
// xlsx and a PDF. The documents are built here, with the paths and the position of a made-up person.
const USER = 'ana.quispe'
const NEUTRAL_TARGET = DocumentSanitizing.NEUTRAL_LOCAL_TARGET
const NEUTRAL_PATH = DocumentSanitizing.NEUTRAL_LOCAL_PATH

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const rels = (...items: string[]): string =>
  `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}">${items.join('')}</Relationships>`
const relationship = (id: string, type: string, target: string, external = false): string =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`

const TEMPLATE_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate'
const LINK_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'

const ROOT_RELS = rels(
  relationship('rId1', 'http://x/officeDocument', 'word/document.xml'),
  relationship(
    'rId2',
    'http://x/package/2006/relationships/metadata/core-properties',
    'docProps/core.xml'
  )
)
const CORE = '<cp:coreProperties><dc:creator>Someone</dc:creator></cp:coreProperties>'

const WORKBOOK = (url: string): string =>
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
  '<mc:Choice Requires="x15">' +
  `<x15ac:absPath xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" url="${url}"/>` +
  '</mc:Choice></mc:AlternateContent><sheets><sheet name="Ventas" sheetId="1"/></sheets></workbook>'

// A package that already holds clean properties, so that what the cleaning does in a test is what the test is about
function pkg(extra: Record<string, string | Uint8Array>): Buffer {
  const parts: Zippable = {
    '[Content_Types].xml': strToU8('<Types/>'),
    '_rels/.rels': strToU8(ROOT_RELS),
    'docProps/core.xml': strToU8(DocumentSanitizing.CORE_PROPERTIES_XML),
    'docProps/app.xml': strToU8(DocumentSanitizing.APP_PROPERTIES_XML),
    'docProps/custom.xml': strToU8(DocumentSanitizing.CUSTOM_PROPERTIES_XML),
    'word/document.xml': strToU8('<w:document>the real text</w:document>')
  }
  for (const [path, body] of Object.entries(extra)) {
    parts[path] = typeof body === 'string' ? strToU8(body) : body
  }
  return Buffer.from(zipSync(parts))
}

const partsOf = async (
  input: Buffer,
  type: string = DocumentSanitizing.DOCX_CONTENT_TYPE
): Promise<{ parts: Record<string, Uint8Array>; keptParts: number }> => {
  const result = await sanitizeDocumentInline(input, type)
  if (result.kind !== 'sanitized')
    throw new Error(`expected a cleaned document, got ${result.kind}`)
  return { parts: unzipSync(new Uint8Array(result.body)), keptParts: result.keptParts }
}

const text = (part: Uint8Array | undefined): string => strFromU8(part ?? new Uint8Array())

// What a phone writes: where, with what, when
const GPS = {
  IFD0: { Make: 'Acme', Model: 'Phone 1' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '4/1 30/1 0/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '74/1 5/1 0/1'
  }
}
const base = (): ReturnType<typeof sharp> =>
  sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 200, g: 30, b: 30 } } })
const geotaggedJpeg = (): Promise<Buffer> => base().withMetadata({ exif: GPS }).jpeg().toBuffer()
const plainJpeg = (): Promise<Buffer> => base().jpeg().toBuffer()
const plainPng = (): Promise<Buffer> => base().png().toBuffer()

describe('the paths of the author in a docx', () => {
  const settingsRels = (target: string): string =>
    rels(relationship('rId1', TEMPLATE_TYPE, target, true))

  it('replaces the attached template and keeps the relationship it belongs to', async () => {
    const input = pkg({
      'word/_rels/settings.xml.rels': settingsRels(
        `file:///C:/Users/${USER}/AppData/Roaming/Templates/Normal.dotm`
      ),
      'word/settings.xml': '<w:settings><w:attachedTemplate r:id="rId1"/></w:settings>'
    })

    const { parts } = await partsOf(input)

    const after = text(parts['word/_rels/settings.xml.rels'])
    expect(after).not.toContain(USER)
    expect(after).toBe(settingsRels(NEUTRAL_TARGET))
    // The part that refers to it by id is the same bytes
    expect(text(parts['word/settings.xml'])).toBe(
      '<w:settings><w:attachedTemplate r:id="rId1"/></w:settings>'
    )
  })

  it.each([
    ['a windows drive', `C:\\Users\\${USER}\\Desktop\\plantilla.dotm`],
    ['a windows drive with slashes', `D:/Users/${USER}/plantilla.dotm`],
    ['a network share', `\\\\servidor\\${USER}\\plantilla.dotm`],
    ['a file uri in capitals', `FILE:///home/${USER}/plantilla.dotm`],
    ['a drive written as character references', `&#67;:\\Users\\${USER}\\x.dotm`],
    ['a scheme written as hexadecimal references', `&#x66;ile:///home/${USER}/x.dotm`],
    ['a path with leading space', `  C:\\Users\\${USER}\\x.dotm`]
  ])('replaces the target that is %s', async (_name, target) => {
    const { parts } = await partsOf(pkg({ 'word/_rels/document.xml.rels': settingsRels(target) }))
    expect(text(parts['word/_rels/document.xml.rels'])).toBe(settingsRels(NEUTRAL_TARGET))
  })

  it('leaves the links that are the content of the document: web, mail, protocol-relative and relative', async () => {
    const links = rels(
      relationship('rId1', LINK_TYPE, 'https://example.com/a?b=1&amp;c=2', true),
      relationship('rId2', LINK_TYPE, 'mailto:ventas@example.com', true),
      relationship('rId3', LINK_TYPE, '//cdn.example.com/logo.png', true),
      relationship('rId4', LINK_TYPE, '../otro/informe.docx', true),
      // A link rooted at the site is a web link, not a path of a machine
      relationship('rId7', LINK_TYPE, '/precios/lista', true),
      relationship('rId5', 'http://x/styles', 'styles.xml'),
      // An internal target is a part of the package: it is never a path of a machine, even when it looks like one
      relationship('rId6', 'http://x/odd', 'file:///kept-because-internal')
    )
    const input = pkg({ 'word/_rels/document.xml.rels': links })

    // Nothing to change in the links, so the package is left as it came
    expect(await sanitizeDocumentInline(input, DocumentSanitizing.DOCX_CONTENT_TYPE)).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
  })

  it('changes only the target that is a path: the other relationships of the same part are the same bytes', async () => {
    const input = pkg({
      'word/_rels/document.xml.rels': rels(
        relationship('rId1', LINK_TYPE, 'https://example.com/', true),
        relationship('rId2', LINK_TYPE, `file:///C:/Users/${USER}/informe.xlsx`, true),
        relationship('rId3', 'http://x/styles', 'styles.xml')
      )
    })

    const { parts } = await partsOf(input)

    expect(text(parts['word/_rels/document.xml.rels'])).toBe(
      rels(
        relationship('rId1', LINK_TYPE, 'https://example.com/', true),
        relationship('rId2', LINK_TYPE, NEUTRAL_TARGET, true),
        relationship('rId3', 'http://x/styles', 'styles.xml')
      )
    )
  })

  it('reaches the relationships of the package itself and of every part, not one place', async () => {
    const input = pkg({
      '_rels/.rels': rels(
        relationship('rId1', 'http://x/officeDocument', 'word/document.xml'),
        relationship(
          'rId2',
          'http://x/package/2006/relationships/metadata/core-properties',
          'docProps/core.xml'
        ),
        relationship('rId9', LINK_TYPE, `file:///C:/Users/${USER}/raiz.docx`, true)
      ),
      'xl/externalLinks/_rels/externalLink1.xml.rels': rels(
        relationship(
          'rId1',
          'http://x/externalLinkPath',
          `file:///C:/Users/${USER}/libro.xlsx`,
          true
        )
      )
    })

    const { parts } = await partsOf(input)

    for (const part of Object.values(parts)) expect(text(part)).not.toContain(USER)
    expect(text(parts['xl/externalLinks/_rels/externalLink1.xml.rels'])).toContain(NEUTRAL_TARGET)
    expect(text(parts['_rels/.rels'])).toContain('docProps/core.xml')
  })

  it('is cleaned once: a document with the neutral target is the same, and so is the result of a run', async () => {
    const dirty = pkg({
      'word/_rels/settings.xml.rels': settingsRels(`file:///C:/Users/${USER}/Normal.dotm`)
    })
    const first = await sanitizeDocumentInline(dirty, DocumentSanitizing.DOCX_CONTENT_TYPE)
    if (first.kind !== 'sanitized') throw new Error('expected a cleaned document')

    expect(await sanitizeDocumentInline(first.body, DocumentSanitizing.DOCX_CONTENT_TYPE)).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
    expect(
      await sanitizeDocumentInline(
        pkg({ 'word/_rels/settings.xml.rels': settingsRels(NEUTRAL_TARGET) }),
        DocumentSanitizing.DOCX_CONTENT_TYPE
      )
    ).toEqual({ kind: 'untouched', why: 'already_clean' })
  })

  it('keeps the document and counts the part when a list of relationships cannot be read', async () => {
    const hostile =
      '<Relationships>' + `<Relationship Id="rId1" Target="file:///C:/Users/${USER}/x"`.repeat(3)
    const big = rels(relationship('rId1', LINK_TYPE, 'https://example.com/', true)).padEnd(
      DocumentSanitizing.MAX_RELATIONSHIPS_BYTES + 1,
      ' '
    )
    const input = pkg({
      'word/_rels/document.xml.rels': hostile,
      'word/_rels/header1.xml.rels': big,
      // Another part has a path, and it is cleaned even so: one bad list never keeps the document from the rest
      'word/_rels/settings.xml.rels': settingsRels(`file:///C:/Users/${USER}/Normal.dotm`)
    })

    const { parts, keptParts } = await partsOf(input)

    expect(keptParts).toBe(2)
    expect(text(parts['word/_rels/settings.xml.rels'])).toBe(settingsRels(NEUTRAL_TARGET))
    expect(text(parts['word/_rels/document.xml.rels'])).toBe(hostile)
  })
})

describe('the paths of the author in an xlsx', () => {
  const XLSX = DocumentSanitizing.XLSX_CONTENT_TYPE

  it('replaces the folder the workbook was saved in and keeps the rest of the part', async () => {
    const input = pkg({
      'xl/workbook.xml': WORKBOOK(`C:\\Users\\${USER}\\Documents\\Ventas 2026\\`)
    })

    const { parts } = await partsOf(input, XLSX)

    expect(text(parts['xl/workbook.xml'])).toBe(WORKBOOK(NEUTRAL_PATH))
    expect(Object.values(parts).some(part => text(part).includes(USER))).toBe(false)
  })

  it('reads the element under any prefix, in single quotes and next to other attributes', async () => {
    const workbook =
      '<workbook><mc:AlternateContent><mc:Choice Requires="x15">' +
      `<ac:absPath xmlns:ac="urn:x" other="1" url = 'C:\\Users\\${USER}\\'/>` +
      '</mc:Choice></mc:AlternateContent></workbook>'

    const { parts } = await partsOf(pkg({ 'xl/workbook.xml': workbook }), XLSX)

    expect(text(parts['xl/workbook.xml'])).toBe(
      workbook.replace(`'C:\\Users\\${USER}\\'`, `"${NEUTRAL_PATH}"`)
    )
  })

  it('is fast on elements that never close: the search for the end is not repeated for each one', async () => {
    const hostile = `<workbook>${'<x15ac:absPath url="C:\\x" '.repeat(60_000)}</workbook>`
    const started = Date.now()

    const { keptParts } = await partsOf(
      pkg({ 'xl/workbook.xml': hostile, 'docProps/core.xml': CORE }),
      XLSX
    )

    expect(Date.now() - started).toBeLessThan(2000)
    expect(keptParts).toBe(60_000)
  })

  it('does not take the word for an element: the name of a sheet or of a defined name is the content', async () => {
    const workbook =
      '<workbook><sheets><sheet name="absPath"/></sheets>' +
      '<definedNames><definedName name="absPath">Hoja1!$A$1</definedName></definedNames>' +
      '<note>absPath url="C:\\Users\\kept\\"</note></workbook>'

    expect(await sanitizeDocumentInline(pkg({ 'xl/workbook.xml': workbook }), XLSX)).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
  })

  it('is fast on a part made of the word, and keeps the document as it came with the part counted', async () => {
    // A quadratic search for the start of each element would take seconds on this
    const hostile = `<workbook>${'absPath'.repeat(9000)}<x15ac:absPath url="C:\\Users\\${USER}\\"${' '.repeat(DocumentSanitizing.MAX_PATH_TAG_BYTES)}/></workbook>`
    const started = Date.now()

    const { keptParts } = await partsOf(
      pkg({ 'xl/workbook.xml': hostile, 'docProps/core.xml': CORE }),
      XLSX
    )

    expect(Date.now() - started).toBeLessThan(2000)
    expect(keptParts).toBe(1)
  })

  it('does not touch the workbook of a docx: the part is looked for by its name', async () => {
    const { parts } = await partsOf(
      pkg({
        'docProps/core.xml': CORE,
        'word/workbook.xml': WORKBOOK(`C:\\Users\\${USER}\\`)
      })
    )
    expect(text(parts['word/workbook.xml'])).toContain(USER)
  })
})

describe('the photos inside a docx and an xlsx', () => {
  const XLSX = DocumentSanitizing.XLSX_CONTENT_TYPE

  it('cleans the position out of a jpeg of word/media, keeps its type and size and leaves every other part as it was', async () => {
    const photo = await geotaggedJpeg()
    expect((await sharp(photo).metadata()).exif).toBeDefined() // The fixture does carry the metadata
    const input = pkg({ 'word/media/image1.jpeg': photo })

    const { parts, keptParts } = await partsOf(input)

    const after = Buffer.from(parts['word/media/image1.jpeg'] as Uint8Array)
    const header = await sharp(after).metadata()
    expect(header.format).toBe('jpeg')
    expect([header.width, header.height]).toEqual([32, 24])
    expect(header.exif).toBeUndefined()
    expect(after.includes('Acme')).toBe(false)
    expect(keptParts).toBe(0)
    expect(text(parts['word/document.xml'])).toBe('<w:document>the real text</w:document>')
  })

  it('cleans a photo of xl/media of an xlsx, and a png and a webp as well', async () => {
    const png = await base().withMetadata({ exif: GPS }).png().toBuffer()
    const webp = await base().withMetadata({ exif: GPS }).webp().toBuffer()
    const input = pkg({
      'xl/media/image1.jpg': await geotaggedJpeg(),
      'xl/media/image2.png': png,
      'xl/media/image3.webp': webp
    })

    const { parts } = await partsOf(input, XLSX)

    for (const [path, format] of [
      ['xl/media/image1.jpg', 'jpeg'],
      ['xl/media/image2.png', 'png'],
      ['xl/media/image3.webp', 'webp']
    ] as const) {
      const header = await sharp(Buffer.from(parts[path] as Uint8Array)).metadata()
      expect(header.format).toBe(format)
      expect(header.exif).toBeUndefined()
    }
  })

  it('leaves a photo that carries nothing exactly as it came, bit for bit, and says the document is clean', async () => {
    const input = pkg({
      'word/media/image1.jpeg': await plainJpeg(),
      'word/media/image2.png': await plainPng()
    })

    expect(await sanitizeDocumentInline(input, DocumentSanitizing.DOCX_CONTENT_TYPE)).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
  })

  it('does not change the photo that carries nothing when another one is cleaned', async () => {
    const plain = await plainJpeg()
    const { parts } = await partsOf(
      pkg({ 'word/media/a.jpeg': await geotaggedJpeg(), 'word/media/b.jpeg': plain })
    )
    expect(Buffer.from(parts['word/media/b.jpeg'] as Uint8Array).equals(plain)).toBe(true)
  })

  it('keeps what it cannot clean as it came and counts it, and still cleans the rest', async () => {
    const geotagged = await geotaggedJpeg()
    // A jpeg that was cut short: it has the signature of one and cannot be decoded
    const damaged = geotagged.subarray(0, 40)
    const input = pkg({
      'word/media/damaged.jpeg': damaged,
      'word/media/ok.jpeg': geotagged,
      // Not a picture the cleaner takes, whatever its name says, and a picture outside the folders of the photos
      'word/media/drawing.emf': Uint8Array.from([1, 0, 0, 0, 0x20, 0x45, 0x4d, 0x46]),
      'customXml/logo.jpeg': geotagged
    })

    const { parts, keptParts } = await partsOf(input)

    expect(keptParts).toBe(1)
    expect(Buffer.from(parts['word/media/damaged.jpeg'] as Uint8Array).equals(damaged)).toBe(true)
    expect(
      (await sharp(Buffer.from(parts['word/media/ok.jpeg'] as Uint8Array)).metadata()).exif
    ).toBeUndefined()
    expect(Buffer.from(parts['customXml/logo.jpeg'] as Uint8Array).equals(geotagged)).toBe(true)
    expect(parts['word/media/drawing.emf']).toEqual(
      Uint8Array.from([1, 0, 0, 0, 0x20, 0x45, 0x4d, 0x46])
    )
  })

  it('judges a photo by its bytes: a jpeg named .png is cleaned as a jpeg, and a text named .jpg is not a photo', async () => {
    const { parts } = await partsOf(
      pkg({
        'word/media/image1.png': await geotaggedJpeg(),
        'word/media/image2.jpg': strToU8('not a picture')
      })
    )
    const header = await sharp(Buffer.from(parts['word/media/image1.png'] as Uint8Array)).metadata()
    expect([header.format, header.exif]).toEqual(['jpeg', undefined])
    expect(text(parts['word/media/image2.jpg'])).toBe('not a picture')
  })

  it('cleans the paths and the photos in the same pass, and the properties too', async () => {
    const input = pkg({
      'docProps/core.xml': `<cp:coreProperties><dc:creator>${USER}</dc:creator></cp:coreProperties>`,
      'word/_rels/settings.xml.rels': rels(
        relationship('rId1', TEMPLATE_TYPE, `file:///C:/Users/${USER}/Normal.dotm`, true)
      ),
      'word/media/image1.jpeg': await geotaggedJpeg()
    })

    const { parts } = await partsOf(input)

    for (const [path, part] of Object.entries(parts)) {
      if (path.startsWith('word/media/')) continue
      expect(text(part)).not.toContain(USER)
    }
    expect(
      (await sharp(Buffer.from(parts['word/media/image1.jpeg'] as Uint8Array)).metadata()).exif
    ).toBeUndefined()
  })

  it('stops cleaning photos when the time of the document is spent, and keeps the rest as it came', async () => {
    const geotagged = await geotaggedJpeg()
    const input = pkg({
      // A property to clean, so that the document is rewritten and the count of what was kept can be read
      'docProps/core.xml': CORE,
      'word/media/a.jpeg': geotagged,
      'word/media/b.jpeg': geotagged,
      'word/media/c.jpeg': geotagged
    })
    // The first reading of the clock sets the deadline; every later one is past it
    const now = jest.spyOn(Date, 'now')
    let reads = 0
    now.mockImplementation(() => {
      reads += 1
      return reads === 1 ? 0 : DocumentSanitizing.EMBEDDED_IMAGES_BUDGET_MS + 1
    })
    try {
      const { parts, keptParts } = await partsOf(input)
      expect(keptParts).toBe(3)
      for (const name of ['a', 'b', 'c']) {
        expect(Buffer.from(parts[`word/media/${name}.jpeg`] as Uint8Array).equals(geotagged)).toBe(
          true
        )
      }
    } finally {
      now.mockRestore()
    }
  })
})

describe('the photos inside a PDF', () => {
  async function pdfWithPhoto(photo: Uint8Array): Promise<Buffer> {
    const doc = await PDFDocument.create({ updateMetadata: false })
    const image = await doc.embedJpg(photo)
    doc.addPage([200, 200]).drawImage(image, { x: 10, y: 10, width: 64, height: 48 })
    doc.addPage([100, 100])
    return Buffer.from(await doc.save({ useObjectStreams: false }))
  }

  it('cuts the position out of a jpeg that the PDF holds as it came, and the picture is the same', async () => {
    const photo = await geotaggedJpeg()
    const dirty = await pdfWithPhoto(photo)
    expect(dirty.includes('Acme')).toBe(true) // The fixture does carry the metadata, as bytes of the PDF

    const result = await sanitizeDocumentInline(dirty, DocumentSanitizing.PDF_CONTENT_TYPE)

    expect(result.kind).toBe('sanitized')
    if (result.kind !== 'sanitized') return
    expect(result.body.includes('Acme')).toBe(false)
    expect(result.body.includes('Exif')).toBe(false)
    const again = await PDFDocument.load(result.body, { updateMetadata: false })
    expect(again.getPageCount()).toBe(2)
    const streams = [...again.context.enumerateIndirectObjects()]
      .map(([, object]) => object)
      .filter((object): object is PDFRawStream => object instanceof PDFRawStream)
      .filter(stream => stream.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))
    expect(streams).toHaveLength(1)
    const [stream] = streams as [PDFRawStream]
    // The dictionary still describes the bytes: the size, the colour space, the filter and the length
    expect(stream.dict.get(PDFName.of('Width'))).toEqual(PDFNumber.of(32))
    expect(stream.dict.get(PDFName.of('Height'))).toEqual(PDFNumber.of(24))
    expect(stream.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'))
    expect(stream.dict.get(PDFName.of('Length'))).toEqual(PDFNumber.of(stream.contents.length))
    const header = await sharp(Buffer.from(stream.contents)).metadata()
    expect([header.format, header.width, header.height, header.exif]).toEqual([
      'jpeg',
      32,
      24,
      undefined
    ])
    // The pixels are the very ones: nothing was encoded again
    const [was, is] = await Promise.all([
      sharp(photo).raw().toBuffer(),
      sharp(Buffer.from(stream.contents)).raw().toBuffer()
    ])
    expect(is.equals(was)).toBe(true)
  })

  it('is a document with something to clean even when the photo is the only thing: and clean once it is done', async () => {
    const dirty = await pdfWithPhoto(await geotaggedJpeg())
    const first = await sanitizeDocumentInline(dirty, DocumentSanitizing.PDF_CONTENT_TYPE)
    if (first.kind !== 'sanitized') throw new Error('expected a cleaned PDF')

    expect(await sanitizeDocumentInline(first.body, DocumentSanitizing.PDF_CONTENT_TYPE)).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
    expect(
      await sanitizeDocumentInline(
        await pdfWithPhoto(await plainJpeg()),
        DocumentSanitizing.PDF_CONTENT_TYPE
      )
    ).toEqual({ kind: 'untouched', why: 'already_clean' })
  })
})
