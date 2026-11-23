import { createHash } from 'node:crypto'

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { PinoLogger } from 'nestjs-pino'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'

import type { JobContext, PrismaService } from '@platform/core/database'
import { sanitizeDocumentInline } from '@platform/core/document-sanitizer'
import {
  DocumentSanitizing,
  ExistingDocumentSweep,
  ExistingPictureSweep,
  MediaPurpose
} from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import { ExistingDocumentSanitizer } from './existing-document-sanitizer.service'
import { InlineDocumentCleaner } from './testing/inline-document-cleaner'

const STORE = 'store-1'
const AUTHOR = 'Jane Q. Author'
const PDF = DocumentSanitizing.PDF_CONTENT_TYPE
const DOCX = DocumentSanitizing.DOCX_CONTENT_TYPE
// What the current version of the cleaning writes on a document it cleaned or found clean, and what the first version wrote
const VERSION_MARK = {
  [ExistingPictureSweep.CLEANED_KEY]: true,
  [DocumentSanitizing.CLEANING_VERSION_KEY]: DocumentSanitizing.CLEANING_VERSION
}
const OLD_MARK = { [ExistingPictureSweep.CLEANED_KEY]: true }
const OLD_CLEAN_MARK = {
  [ExistingPictureSweep.CLEANED_KEY]: true,
  [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.ALREADY_CLEAN
}

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
  const result = await sanitizeDocumentInline(await pdfWithMarkers(), PDF)
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
    delete: jest.fn((key: string) => {
      bucket.delete(key)
      return Promise.resolve()
    }),
    put: jest.fn((key: string, body: Buffer) => {
      if (failPutOn.has(key)) return Promise.reject(new Error('the bucket refused the write'))
      puts.push(key)
      bucket.set(key, body)
      return Promise.resolve()
    })
  }
  // A row is not finished while it has no scan_result or fewer attempts than the limit
  const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  // A row that an older version finished: exactly the mark it wrote (the query matches it whole, not by a missing key)
  // The conditions of the query, read as the database reads them: a null, a whole value, or a number under a key
  const matchesOne = (row: Row, condition: { scanResult: Record<string, unknown> }): boolean => {
    const guard = condition.scanResult
    const path = guard.path as string[] | undefined
    if (path !== undefined) {
      const value = row.scanResult?.[path[0] as string]
      if (typeof value !== 'number') return false
      return 'lt' in guard ? value < (guard.lt as number) : value === guard.equals
    }
    return isMark(guard.equals) ? sameJson(row.scanResult, guard.equals) : row.scanResult === null
  }
  const matchesQuery = (row: Row, where: Record<string, unknown>): boolean =>
    (where.OR as { scanResult: Record<string, unknown> }[]).some(condition =>
      matchesOne(row, condition)
    )
  const notFinished = (row: Row): boolean =>
    row.scanResult === null ||
    (typeof row.scanResult[ExistingPictureSweep.ATTEMPTS_KEY] === 'number' &&
      (row.scanResult[ExistingPictureSweep.ATTEMPTS_KEY] as number) <
        ExistingDocumentSweep.MAX_ATTEMPTS &&
      row.scanResult[ExistingPictureSweep.OUTCOME_KEY] === undefined)
  // A whole-value guard (`{ equals: { sanitized: true } }`), as against the null that `DatabaseNull` stands for
  const isMark = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && Object.keys(value).length > 0
  const prisma = {
    client: {
      media: {
        findFirst: jest.fn((args: { where: { id: string } }) =>
          Promise.resolve(rows.find(candidate => candidate.id === args.where.id) ?? null)
        ),
        findMany: jest.fn((args: { where: Record<string, unknown>; take: number }) => {
          findManyArgs.push(args)
          return Promise.resolve(
            rows
              .filter(row => matchesQuery(row, args.where))
              .sort((a, b) => a.id.localeCompare(b.id))
              .slice(0, args.take)
          )
        }),
        updateMany: jest.fn(
          (args: {
            where: { id: string; scanResult?: { path?: string[]; equals?: unknown } }
            data: { fileSize?: number; scanResult: object }
          }) => {
            const row = rows.find(candidate => candidate.id === args.where.id)
            if (row === undefined) return Promise.resolve({ count: 0 })
            const guard = args.where.scanResult
            const allowed =
              guard?.path !== undefined
                ? row.scanResult?.[guard.path[0] as string] === guard.equals
                : guard?.equals !== undefined
                  ? isMark(guard.equals)
                    ? sameJson(row.scanResult, guard.equals)
                    : row.scanResult === null
                  : notFinished(row)
            if (!allowed) return Promise.resolve({ count: 0 })
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
  const cleaner = new InlineDocumentCleaner()
  const sanitizer = new ExistingDocumentSanitizer(
    prisma as unknown as PrismaService,
    { forStore: (_id: string, work: () => Promise<unknown>) => work() } as unknown as JobContext,
    storage as unknown as StorageService,
    logger as unknown as PinoLogger,
    cleaner
  )

  function store(
    id: string,
    body: Buffer,
    options: {
      contentType?: string
      purpose?: string
      scanResult?: Row['scanResult']
      key?: string
    } = {}
  ): Row {
    const key = options.key ?? `stores/${STORE}/${id}`
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
    expect(row.scanResult).toEqual(VERSION_MARK)
    expect(row.fileSize).toBe(body.length)
  })

  it('cleans a stored docx of its properties and of the path of its author and keeps its content', async () => {
    const row = store('d2', docxWithUserPath(), { contentType: DOCX })

    const report = await sanitizer.runScoped([STORE])

    expect(report.cleaned).toBe(1)
    const parts = unzipSync(new Uint8Array(bucket.get(row.key) as Buffer))
    expect(strFromU8(parts['docProps/core.xml'] as Uint8Array)).not.toContain(AUTHOR)
    expect(strFromU8(parts['word/document.xml'] as Uint8Array)).toContain('the real text')
    // The path of the author is gone (Step 7.3, `office-user-paths-and-embedded-media`) and the relationship stays
    const rels = strFromU8(parts['word/_rels/settings.xml.rels'] as Uint8Array)
    expect(rels).not.toContain(USER_PATH)
    expect(rels).toContain(DocumentSanitizing.NEUTRAL_LOCAL_TARGET)
    expect(rels).toContain('Id="rId1"')
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
    expect(first.scanResult).toEqual(VERSION_MARK)

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
      ...VERSION_MARK,
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.ALREADY_CLEAN
    })
  })

  it('takes back the file it wrote when the row was deleted while the file was written, so a deleted file does not come back', async () => {
    const row = store('d1', await pdfWithMarkers())
    // The row is deleted (a deletion of the conversation) in the middle of the write
    storage.put.mockImplementationOnce((key: string, body: Buffer) => {
      bucket.set(key, body)
      rows.splice(rows.indexOf(row), 1)
      return Promise.resolve()
    })

    const report = await sanitizer.runScoped([STORE])

    expect(report.cleaned).toBe(0)
    expect(bucket.has(row.key)).toBe(false)
  })

  it('keeps the file it wrote when the row moved on but still exists', async () => {
    const row = store('d1', await pdfWithMarkers())
    storage.put.mockImplementationOnce((key: string, body: Buffer) => {
      bucket.set(key, body)
      row.scanResult = { [ExistingPictureSweep.CLEANED_KEY]: true } // another writer finished the row
      return Promise.resolve()
    })

    await sanitizer.runScoped([STORE])

    expect(bucket.has(row.key)).toBe(true)
  })

  it('makes the size of the row true when it only marks a file that a crash left cleaned', async () => {
    const clean = await cleanPdf()
    const row = store('d1', clean)
    row.fileSize = clean.length + 500 // the size from before the cleaning

    await sanitizer.runScoped([STORE])

    expect(row.fileSize).toBe(clean.length)
  })

  it('counts the attempt before it opens the file: a document that hangs or kills the process is given up after the last attempt and never opened again', async () => {
    const dirty = await pdfWithMarkers()
    const row = store('d1', dirty)
    // The parse never answers: the process is as good as dead, no handler will run
    for (let attempt = 1; attempt <= ExistingDocumentSweep.MAX_ATTEMPTS; attempt += 1) {
      storage.read.mockImplementationOnce(() => new Promise<never>(() => undefined))
      void sanitizer.runScoped([STORE])
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      expect(row.scanResult).toEqual({ [ExistingPictureSweep.ATTEMPTS_KEY]: attempt })
    }
    const readsBefore = storage.read.mock.calls.length

    const report = await sanitizer.runScoped([STORE])

    expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    expect(storage.read.mock.calls.length).toBe(readsBefore) // it was not opened a fourth time
    expect(bucket.get(row.key)).toBe(dirty)
  })

  it('does not mark a document whose thread passed its deadline: it is tried again, and given up after the last attempt', async () => {
    const dirty = await pdfWithMarkers()
    const row = store('d1', dirty)
    const timedOut = jest
      .spyOn(cleaner, 'clean')
      .mockResolvedValue({ kind: 'untouched', why: 'timed_out' })
    try {
      for (let attempt = 1; attempt <= ExistingDocumentSweep.MAX_ATTEMPTS; attempt += 1) {
        const report = await sanitizer.runScoped([STORE])
        expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 1, failed: 0 })
        // Not `not_cleanable`: a slow worker can cut a good file; only the attempt is written
        expect(row.scanResult).toEqual({ [ExistingPictureSweep.ATTEMPTS_KEY]: attempt })
      }
      const calls = timedOut.mock.calls.length
      await sanitizer.runScoped([STORE])
      expect(timedOut.mock.calls.length).toBe(calls) // a file that always hangs is not parsed a fourth time
    } finally {
      timedOut.mockRestore()
    }
    expect(bucket.get(row.key)).toBe(dirty)
    expect(storage.put).not.toHaveBeenCalled()
  })

  it('uses no attempt while a thread that could not be stopped is alive: the documents wait for the next run', async () => {
    const rowsOf = [
      store('d1', await pdfWithMarkers()),
      store('d2', await pdfWithMarkers()),
      store('d3', await pdfWithMarkers())
    ]
    const busy = jest.spyOn(cleaner, 'isBusy').mockReturnValue(true)
    const clean = jest.spyOn(cleaner, 'clean')
    try {
      const report = await sanitizer.runScoped([STORE])
      expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
      // None was opened and none was counted: their rows are as they were
      expect(clean).not.toHaveBeenCalled()
      for (const row of rowsOf) expect(row.scanResult).toBeNull()
      expect(storage.read).not.toHaveBeenCalled()
    } finally {
      busy.mockRestore()
      clean.mockRestore()
    }
    // Once the thread is gone the same documents are cleaned
    const again = await sanitizer.runScoped([STORE])
    expect(again.cleaned).toBe(3)
  })

  it('does not cut a slow document at the budget of the run: it finishes clean with no attempt left on the row, and the next one is not opened', async () => {
    const dirty = await pdfWithMarkers()
    const slow = store('d1', dirty)
    const next = store('d2', dirty)
    let now = 1_000_000
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    // The write of the first document ends after the budget of the run: a slow document, not a dead one
    storage.put.mockImplementationOnce((key: string, body: Buffer) => {
      bucket.set(key, body)
      now += ExistingDocumentSweep.MAX_RUN_MS + 1
      return Promise.resolve()
    })

    const report = await sanitizer.runScoped([STORE])
    clock.mockRestore()

    expect(report).toEqual({ cleaned: 1, alreadyClean: 0, skipped: 0, failed: 0 })
    expect(slow.scanResult).toEqual(VERSION_MARK) // the attempt was replaced by the mark
    expect(next.scanResult).toBeNull() // never begun, so no attempt was counted against it
    expect(bucket.get(next.key)).toBe(dirty)
  })

  it('never reads, writes or deletes a key outside the folder of its store, and marks the row', async () => {
    const outside = store('d1', await pdfWithMarkers(), { key: 'stores/other-store/d1' })
    const walking = store('d2', await pdfWithMarkers(), { key: `stores/${STORE}/../other/d2` })
    const before = [bucket.get(outside.key), bucket.get(walking.key)]

    const report = await sanitizer.runScoped([STORE])

    expect(report.skipped).toBe(2)
    expect(storage.read).not.toHaveBeenCalled()
    expect(puts).toEqual([])
    expect(storage.delete).not.toHaveBeenCalled()
    expect([bucket.get(outside.key), bucket.get(walking.key)]).toEqual(before)
    for (const row of [outside, walking]) {
      expect(row.scanResult).toEqual({
        [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.FOREIGN_KEY
      })
    }
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
    // Not finished: it only holds the attempt that was counted before the file was opened
    expect(row.scanResult).toEqual({ [ExistingPictureSweep.ATTEMPTS_KEY]: 1 })
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
  // Step 7.3 (`office-user-paths-and-embedded-media`): a document that the first version of the cleaning finished is taken again by the version
  // that also cleans the paths of the author and the photos inside it
  describe('a document that an older version of the cleaning finished', () => {
    const DOCX_RELS_PATH = 'word/_rels/settings.xml.rels'

    it('is taken again, cleaned of what the older version left, and marked with the current version', async () => {
      const row = store('d1', docxWithUserPath(), {
        contentType: DOCX,
        scanResult: { ...OLD_MARK }
      })

      const report = await sanitizer.runScoped([STORE])

      expect(report).toEqual({ cleaned: 1, alreadyClean: 0, skipped: 0, failed: 0 })
      const parts = unzipSync(new Uint8Array(bucket.get(row.key) as Buffer))
      expect(strFromU8(parts[DOCX_RELS_PATH] as Uint8Array)).not.toContain(USER_PATH)
      expect(row.scanResult).toEqual(VERSION_MARK)
      expect(row.fileSize).toBe((bucket.get(row.key) as Buffer).length)
    })

    it('is taken again when the older version had found it clean, and only marked when it still is: nothing is written', async () => {
      const clean = await cleanPdf()
      const row = store('d1', clean, { scanResult: { ...OLD_CLEAN_MARK } })

      const report = await sanitizer.runScoped([STORE])

      expect(report).toMatchObject({ alreadyClean: 1, cleaned: 0 })
      expect(puts).toEqual([])
      expect(bucket.get(row.key)).toBe(clean)
      expect(row.scanResult).toEqual({
        ...VERSION_MARK,
        [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.ALREADY_CLEAN
      })
    })

    it('is taken once: after the current version marks it, the next run does not open it', async () => {
      store('d1', docxWithUserPath(), { contentType: DOCX, scanResult: { ...OLD_MARK } })
      store('d2', await cleanPdf(), { scanResult: { ...OLD_CLEAN_MARK } })
      await sanitizer.runScoped([STORE])
      storage.read.mockClear()

      const again = await sanitizer.runScoped([STORE])

      expect(again).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
      expect(storage.read).not.toHaveBeenCalled()
    })

    it('is taken again when it carries a version below the current one: a later version of the cleaning needs no new mark in the query', async () => {
      const row = store('d1', docxWithUserPath(), {
        contentType: DOCX,
        scanResult: { ...VERSION_MARK, [DocumentSanitizing.CLEANING_VERSION_KEY]: 1 }
      })

      const report = await sanitizer.runScoped([STORE])

      expect(report).toMatchObject({ cleaned: 1 })
      expect(row.scanResult).toEqual(VERSION_MARK)
    })

    it('is not taken when the current version already marked it, or when the mark is anything else', async () => {
      const dirty = docxWithUserPath()
      const marks: Record<string, unknown>[] = [
        { ...VERSION_MARK },
        // What an older run could not clean stays that way: the reason it was kept (encrypted, signed, damaged) is still true of it
        { [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.NOT_CLEANABLE },
        { [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.FAILED },
        { [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.MISSING },
        // The mark of an older version is the whole value, never a value with something else in it
        { ...OLD_MARK, extra: 1 },
        // A version above the current one (a rollback of the code) is not taken either
        { ...VERSION_MARK, [DocumentSanitizing.CLEANING_VERSION_KEY]: 99 }
      ]
      const taken = marks.map((mark, index) =>
        store(`d${index}`, dirty, { contentType: DOCX, scanResult: mark })
      )

      const report = await sanitizer.runScoped([STORE])

      expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
      expect(puts).toEqual([])
      taken.forEach((row, index) => expect(row.scanResult).toEqual(marks[index]))
    })

    it('does not mark a row that changed between the read of the batch and the first write: the guard is the whole mark it read', async () => {
      const row = store('d1', docxWithUserPath(), {
        contentType: DOCX,
        scanResult: { ...OLD_MARK }
      })
      // Someone else moves the row on after the batch was read and before the sweep begins on it
      const read = prisma.client.media.findMany.getMockImplementation()
      type Args = { where: Record<string, unknown>; take: number }
      prisma.client.media.findMany.mockImplementationOnce(async (args: Args) => {
        // The batch is a copy of what was read: the row moves on behind it
        const found = (await (read as (a: Args) => Promise<Row[]>)(args)).map(each => ({
          ...each
        }))
        row.scanResult = { ...VERSION_MARK }
        return found
      })

      const report = await sanitizer.runScoped([STORE])

      expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 1, failed: 0 })
      expect(puts).toEqual([])
      expect(row.scanResult).toEqual(VERSION_MARK)
    })
  })
})
