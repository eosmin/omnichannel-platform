import { createHash } from 'node:crypto'

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { PinoLogger } from 'nestjs-pino'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'

import type { JobContext, PrismaService } from '@platform/core/database'
import { sanitizeDocument } from '@platform/core/document-sanitizer'
import {
  DocumentSanitizing,
  ExistingDocumentSweep,
  ExistingPictureSweep,
  MediaPurpose
} from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import { ExistingDocumentSanitizer } from './existing-document-sanitizer.service'

const STORE = 'store-1'
const AUTHOR = 'Jane Q. Author'
const PDF = DocumentSanitizing.PDF_CONTENT_TYPE
const DOCX = DocumentSanitizing.DOCX_CONTENT_TYPE

interface Row {
  id: string
  key: string
  contentType: string
  purpose: string
  fileSize: number
  scanResult: Record<string, unknown> | null
}

const leaks = (body: Buffer, text: string): boolean =>
  body.includes(text) ||
  body.includes(Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase())

async function pdfWithMarkers(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([100, 100])
  doc.setAuthor(AUTHOR)
  const { context } = doc
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
    context.obj({ Title: PDFString.of('Chapter one'), Parent: outlines, Dest: [page.ref, 'Fit'] })
  )
  doc.catalog.set(PDFName.of('Outlines'), outlines)
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

// The output of the cleaner is its own fixed point: a PDF that a crash left cleaned in the bucket
async function cleanPdf(): Promise<Buffer> {
  const result = await sanitizeDocument(await pdfWithMarkers(), PDF)
  if (result.kind !== 'sanitized') throw new Error('the fixture was not cleaned')
  return result.body
}

const OFFICE_RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://x/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
const USER_PATH = 'file:///C:/Users/jane/Templates/Normal.dotm'

function docxWithUserPath(): Buffer {
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      '_rels/.rels': strToU8(OFFICE_RELS),
      'docProps/core.xml': strToU8(
        `<cp:coreProperties><dc:creator>${AUTHOR}</dc:creator></cp:coreProperties>`
      ),
      'word/_rels/settings.xml.rels': strToU8(
        `<Relationships><Relationship Id="rId1" Type="attachedTemplate" Target="${USER_PATH}" TargetMode="External"/></Relationships>`
      ),
      'word/document.xml': strToU8('<w:document>the real text</w:document>')
    })
  )
}

// The decisions of the sweep of stored documents against an in-memory bucket and table, with the real cleaner: what a customer sees of a
// document survives, a failing bucket loses nothing, and a repeat does nothing. The real database and bucket are in the integration spec.
describe('ExistingDocumentSanitizer', () => {
  let bucket: Map<string, Buffer>
  let rows: Row[]
  let failPutOn: Set<string>
  let findManyArgs: { where: Record<string, unknown>; take: number }[]
  let puts: string[]
  // Lets a case answer the second look at an object differently from the first (someone else wrote it in between)
  let headCalls: Map<string, number>
  let changeAfterFirstHead: boolean

  const etagOf = (key: string): string =>
    createHash('md5')
      .update(bucket.get(key) ?? '')
      .digest('hex')
  const storage = {
    head: jest.fn((key: string) => {
      const body = bucket.get(key)
      if (body === undefined) return Promise.resolve(null)
      const calls = (headCalls.get(key) ?? 0) + 1
      headCalls.set(key, calls)
      const changed = changeAfterFirstHead && calls > 1
      return Promise.resolve({
        etag: changed ? 'changed' : etagOf(key),
        contentLength: body.length
      })
    }),
    read: jest.fn((key: string) => Promise.resolve(bucket.get(key) ?? null)),
    put: jest.fn((key: string, body: Buffer) => {
      if (failPutOn.has(key)) return Promise.reject(new Error('the bucket refused the write'))
      puts.push(key)
      bucket.set(key, body)
      return Promise.resolve()
    })
  }
  // A row is not finished while it has no scan_result or fewer attempts than the limit
  const notFinished = (row: Row): boolean =>
    row.scanResult === null ||
    (typeof row.scanResult[ExistingPictureSweep.ATTEMPTS_KEY] === 'number' &&
      (row.scanResult[ExistingPictureSweep.ATTEMPTS_KEY] as number) <
        ExistingDocumentSweep.MAX_ATTEMPTS &&
      row.scanResult[ExistingPictureSweep.OUTCOME_KEY] === undefined)
  const prisma = {
    client: {
      media: {
        findMany: jest.fn((args: { where: Record<string, unknown>; take: number }) => {
          findManyArgs.push(args)
          return Promise.resolve(
            rows
              .filter(notFinished)
              .sort((a, b) => a.id.localeCompare(b.id))
              .slice(0, args.take)
          )
        }),
        updateMany: jest.fn(
          (args: { where: { id: string }; data: { fileSize?: number; scanResult: object } }) => {
            const row = rows.find(candidate => candidate.id === args.where.id)
            if (row === undefined || !notFinished(row)) return Promise.resolve({ count: 0 })
            row.scanResult = args.data.scanResult as Record<string, unknown>
            if (args.data.fileSize !== undefined) row.fileSize = args.data.fileSize
            return Promise.resolve({ count: 1 })
          }
        )
      },
      store: { findMany: jest.fn() }
    }
  }
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const sanitizer = new ExistingDocumentSanitizer(
    prisma as unknown as PrismaService,
    { forStore: (_id: string, work: () => Promise<unknown>) => work() } as unknown as JobContext,
    storage as unknown as StorageService,
    logger as unknown as PinoLogger
  )

  function store(
    id: string,
    body: Buffer,
    options: { contentType?: string; purpose?: string; scanResult?: Row['scanResult'] } = {}
  ): Row {
    const key = `stores/${STORE}/${id}`
    bucket.set(key, body)
    const row: Row = {
      id,
      key,
      contentType: options.contentType ?? PDF,
      purpose: options.purpose ?? MediaPurpose.MESSAGE,
      fileSize: body.length,
      scanResult: options.scanResult ?? null
    }
    rows.push(row)
    return row
  }

  beforeEach(() => {
    bucket = new Map()
    rows = []
    failPutOn = new Set()
    findManyArgs = []
    puts = []
    headCalls = new Map()
    changeAfterFirstHead = false
    jest.clearAllMocks()
  })

  it('cleans a stored PDF, keeps its bookmarks and comments, and marks the row with the new size', async () => {
    const dirty = await pdfWithMarkers()
    const row = store('d1', dirty)

    const report = await sanitizer.runScoped([STORE])

    expect(report).toEqual({ cleaned: 1, alreadyClean: 0, skipped: 0, failed: 0 })
    const body = bucket.get(row.key) as Buffer
    expect(leaks(dirty, AUTHOR)).toBe(true)
    expect(leaks(body, AUTHOR)).toBe(false)
    expect(body.includes('customer note body')).toBe(true)
    expect(body.includes('Chapter one')).toBe(true)
    const again = await PDFDocument.load(body)
    expect(again.catalog.get(PDFName.of('Outlines'))).toBeDefined()
    expect(again.getPage(0).node.Annots()?.size()).toBe(1)
    expect(row.scanResult).toEqual({ [ExistingPictureSweep.CLEANED_KEY]: true })
    expect(row.fileSize).toBe(body.length)
  })

  it('cleans a stored docx of its properties and keeps its content, and says where the path of a user stays (Step 7.3)', async () => {
    const row = store('d2', docxWithUserPath(), { contentType: DOCX })

    const report = await sanitizer.runScoped([STORE])

    expect(report.cleaned).toBe(1)
    const parts = unzipSync(new Uint8Array(bucket.get(row.key) as Buffer))
    expect(strFromU8(parts['docProps/core.xml'] as Uint8Array)).not.toContain(AUTHOR)
    expect(strFromU8(parts['word/document.xml'] as Uint8Array)).toContain('the real text')
    // Known limit, written in the plan (task `office-user-paths-and-embedded-media`): the sweep does not rewrite the relationships
    expect(strFromU8(parts['word/_rels/settings.xml.rels'] as Uint8Array)).toContain(USER_PATH)
  })

  it('does not lose the original when the bucket refuses the write, tries again on the next run and then does nothing', async () => {
    const dirty = await pdfWithMarkers()
    const first = store('d1', dirty)
    const second = store('d2', dirty)
    failPutOn.add(second.key)

    const run1 = await sanitizer.runScoped([STORE])

    expect(run1).toMatchObject({ cleaned: 1, failed: 1 })
    expect(bucket.get(second.key)).toBe(dirty) // the original, untouched
    expect(second.scanResult).toEqual({ [ExistingPictureSweep.ATTEMPTS_KEY]: 1 })
    expect(first.scanResult).toEqual({ [ExistingPictureSweep.CLEANED_KEY]: true })

    failPutOn.clear()
    const run2 = await sanitizer.runScoped([STORE])
    expect(run2).toMatchObject({ cleaned: 1, failed: 0 })
    expect(leaks(bucket.get(second.key) as Buffer, AUTHOR)).toBe(false)

    puts.length = 0
    const run3 = await sanitizer.runScoped([STORE])
    expect(run3).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    expect(puts).toEqual([])
  })

  it('gives a document up as failed after the last attempt, with its original still in the bucket', async () => {
    const dirty = await pdfWithMarkers()
    const row = store('d1', dirty)
    failPutOn.add(row.key)

    for (let attempt = 0; attempt < ExistingDocumentSweep.MAX_ATTEMPTS; attempt += 1) {
      await sanitizer.runScoped([STORE])
    }

    expect(bucket.get(row.key)).toBe(dirty)
    expect(row.scanResult).toEqual({
      [ExistingPictureSweep.ATTEMPTS_KEY]: ExistingDocumentSweep.MAX_ATTEMPTS,
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.FAILED
    })
    expect(await sanitizer.runScoped([STORE])).toEqual({
      cleaned: 0,
      alreadyClean: 0,
      skipped: 0,
      failed: 0
    })
  })

  it('only marks a document that is clean already (a crash between the write and the mark), without writing it', async () => {
    const row = store('d1', await cleanPdf())

    const report = await sanitizer.runScoped([STORE])

    expect(report).toMatchObject({ alreadyClean: 1, cleaned: 0 })
    expect(puts).toEqual([])
    expect(row.scanResult).toEqual({
      [ExistingPictureSweep.CLEANED_KEY]: true,
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.ALREADY_CLEAN
    })
  })

  it('leaves as it is, and marks, a document that cannot be cleaned without risk', async () => {
    const damaged = Buffer.from('%PDF-1.7 this is not a pdf')
    const row = store('d1', damaged)

    const report = await sanitizer.runScoped([STORE])

    expect(report).toMatchObject({ skipped: 1, cleaned: 0 })
    expect(bucket.get(row.key)).toBe(damaged)
    expect(row.scanResult).toEqual({
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.NOT_CLEANABLE
    })
  })

  it('marks as missing a row whose file is not in the bucket, and deletes nothing', async () => {
    const row = store('d1', await pdfWithMarkers())
    bucket.delete(row.key)

    const report = await sanitizer.runScoped([STORE])

    expect(report.skipped).toBe(1)
    expect(row.scanResult).toEqual({
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.MISSING
    })
  })

  it('leaves the document alone, unmarked, when the object changed between the read and the write', async () => {
    const dirty = await pdfWithMarkers()
    const row = store('d1', dirty)
    changeAfterFirstHead = true

    const report = await sanitizer.runScoped([STORE])

    expect(report).toMatchObject({ skipped: 1, cleaned: 0 })
    expect(puts).toEqual([])
    expect(bucket.get(row.key)).toBe(dirty)
    expect(row.scanResult).toBeNull()
  })

  it('never reads or rewrites evidence, even if a row of evidence reaches the batch', async () => {
    for (const purpose of [MediaPurpose.FINANCE_DOCUMENT, MediaPurpose.FISCAL_EVIDENCE]) {
      const row = store(`e-${purpose}`, await pdfWithMarkers(), { purpose })
      const before = bucket.get(row.key)
      await sanitizer.runScoped([STORE])
      expect(bucket.get(row.key)).toBe(before)
      expect(row.scanResult).toBeNull()
    }
    expect(storage.read).not.toHaveBeenCalled()
    expect(puts).toEqual([])
  })

  it('asks only for clean documents of the four purposes and the three types, in a bounded batch', async () => {
    await sanitizer.runScoped([STORE])

    const [call] = findManyArgs
    expect(call?.take).toBe(ExistingDocumentSweep.BATCH_PER_STORE)
    const where = call?.where as {
      storeId: string
      status: string
      purpose: { in: string[] }
      contentType: { in: string[] }
    }
    expect(where.storeId).toBe(STORE)
    expect(where.status).toBe('clean')
    expect(where.purpose.in).toEqual(['message', 'origin', 'product', 'order'])
    expect(where.contentType.in).toEqual([PDF, DOCX, DocumentSanitizing.XLSX_CONTENT_TYPE])
  })

  it('stops at the budget of a run and leaves the rest for the next one', async () => {
    const dirty = await pdfWithMarkers()
    for (let n = 0; n < ExistingDocumentSweep.BATCH_PER_STORE + 3; n += 1) {
      store(`d${String(n).padStart(3, '0')}`, dirty)
    }

    const report = await sanitizer.runScoped([STORE])

    expect(report.cleaned).toBe(ExistingDocumentSweep.BATCH_PER_STORE)
    expect(rows.filter(row => row.scanResult === null)).toHaveLength(3)
  })
})
