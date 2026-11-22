import { randomUUID } from 'node:crypto'

import { Test, type TestingModule } from '@nestjs/testing'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import pg from 'pg'

import { PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import {
  DocumentSanitizing,
  ExistingDocumentSweep,
  ExistingPictureSweep,
  StorageKeys
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { WorkerModule } from '../worker.module'

import { DocumentCleaner } from './document-cleaner'
import { ExistingDocumentSanitizer } from './existing-document-sanitizer.service'
import { InlineDocumentCleaner } from './testing/inline-document-cleaner'

const AUTHOR = 'Jane Q. Author'

interface MediaRow {
  status: string
  key: string
  fileSize: number
  scanResult: unknown
}

async function pdfWithMarkers(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([100, 100])
  doc.setAuthor(AUTHOR)
  const { context } = doc
  const annotation = context.register(
    context.obj({
      Subtype: 'Text',
      Rect: [10, 10, 30, 30],
      Contents: PDFString.of('customer note body')
    })
  )
  page.node.set(PDFName.of('Annots'), context.obj([annotation]))
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

// The sweep of the documents stored before their cleaning existed, against the real bucket and database. Every case names the stores it
// sweeps (runScoped): the database and the bucket are shared with other suites.
describe('ExistingDocumentSanitizer', () => {
  let moduleRef: TestingModule
  let sanitizer: ExistingDocumentSanitizer
  let storage: StorageService
  let owner: pg.Client
  const organizationId = randomUUID()
  const storeId = randomUUID()
  const keys: string[] = []

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      // The thread is a file of the bundle (`document-thread.js`), which a run under ts-jest does not have: it is checked on the built bundle
      // by `scripts/smoke-document-thread.ts` (CI), and its behavior by `thread-document-cleaner.spec.ts`
      .overrideProvider(DocumentCleaner)
      .useValue(new InlineDocumentCleaner())
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ databaseUrl: connectionUrls().worker }))
      .compile()
    sanitizer = moduleRef.get(ExistingDocumentSanitizer, { strict: false })
    storage = moduleRef.get(StorageService, { strict: false })
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    const slug = `it-docsweep-${storeId.slice(0, 8)}`
    await owner.query(
      `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $2, now())`,
      [organizationId, slug]
    )
    await owner.query(
      `INSERT INTO stores (id, organization_id, name, slug, updated_at) VALUES ($1, $2, $3, $3, now())`,
      [storeId, organizationId, slug]
    )
  })

  afterAll(async () => {
    for (const key of keys) await storage.delete(key)
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [organizationId])
    await owner.end()
    await moduleRef.close()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // A document stored before the cleaning existed: clean, served, with no `scan_result`
  async function oldDocument(
    body: Buffer,
    options: { purpose?: string; status?: string; scanResult?: object } = {}
  ): Promise<{ id: string; key: string }> {
    const id = randomUUID()
    const key = StorageKeys.message(storeId, id, 'file.pdf')
    await storage.put(key, body, DocumentSanitizing.PDF_CONTENT_TYPE)
    keys.push(key)
    await owner.query(
      `INSERT INTO media (id, store_id, purpose, key, filename, content_type, file_size, status, scan_result)
       VALUES ($1, $2, $3, $4, 'file.pdf', $5, $6, $7, $8)`,
      [
        id,
        storeId,
        options.purpose ?? 'message',
        key,
        DocumentSanitizing.PDF_CONTENT_TYPE,
        body.length,
        options.status ?? 'clean',
        options.scanResult === undefined ? null : JSON.stringify(options.scanResult)
      ]
    )
    return { id, key }
  }

  async function row(id: string): Promise<MediaRow> {
    const { rows } = await owner.query<MediaRow>(
      `SELECT status, key, file_size AS "fileSize", scan_result AS "scanResult" FROM media WHERE id = $1`,
      [id]
    )
    const found = rows[0]
    if (found === undefined) throw new Error(`the media ${id} has no row`)
    return found
  }

  async function stored(key: string): Promise<Buffer> {
    const body = await storage.read(key, 10 * 1024 * 1024)
    if (body === null) throw new Error('the file is not in the bucket')
    return body
  }

  it('takes the author out of a stored PDF, keeps its comments, its id and key, and keeps the row true to its size', async () => {
    const media = await oldDocument(await pdfWithMarkers())

    const report = await sanitizer.runScoped([storeId])

    expect(report).toMatchObject({ cleaned: 1, failed: 0 })
    const kept = await stored(media.key)
    expect(kept.includes(AUTHOR)).toBe(false)
    expect(kept.includes('customer note body')).toBe(true)
    const after = await row(media.id)
    expect(after.key).toBe(media.key)
    expect(after.status).toBe('clean')
    expect(after.fileSize).toBe(kept.length)
    expect(after.scanResult).toEqual({ [ExistingPictureSweep.CLEANED_KEY]: true })
  })

  it('is safe to repeat: a document already cleaned is not taken again, and its bytes do not change', async () => {
    const media = await oldDocument(await pdfWithMarkers())
    await sanitizer.runScoped([storeId])
    const once = await stored(media.key)

    const report = await sanitizer.runScoped([storeId])

    expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    expect((await stored(media.key)).equals(once)).toBe(true)
  })

  it('does not lose the original when the bucket refuses the write, and cleans it on the next run', async () => {
    const original = await pdfWithMarkers()
    const media = await oldDocument(original)
    jest.spyOn(storage, 'put').mockRejectedValueOnce(new Error('the bucket is down'))

    const failed = await sanitizer.runScoped([storeId])

    expect(failed).toMatchObject({ cleaned: 0, failed: 1 })
    expect((await stored(media.key)).equals(original)).toBe(true) // The original is there, byte for byte
    expect((await row(media.id)).scanResult).toEqual({ [ExistingPictureSweep.ATTEMPTS_KEY]: 1 })
    const retried = await sanitizer.runScoped([storeId])
    expect(retried).toMatchObject({ cleaned: 1, failed: 0 })
    expect((await stored(media.key)).includes(AUTHOR)).toBe(false)
  })

  it('leaves a document that cannot be cleaned where it is, never deletes it, and does not take it again', async () => {
    const damaged = Buffer.from('%PDF-1.7 this is not a pdf')
    const media = await oldDocument(damaged)

    const first = await sanitizer.runScoped([storeId])
    const second = await sanitizer.runScoped([storeId])

    expect(first).toMatchObject({ skipped: 1, cleaned: 0, failed: 0 })
    expect(second).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    expect((await stored(media.key)).equals(damaged)).toBe(true)
    expect((await row(media.id)).scanResult).toEqual({
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.NOT_CLEANABLE
    })
  })

  it('leaves alone what is not a clean document of the sweep: a pending one, financial evidence (fiscal evidence needs a fiscal document: the unit spec covers it), and one the scan already marked', async () => {
    const original = await pdfWithMarkers()
    const pending = await oldDocument(original, { status: 'pending' })
    const evidence = await oldDocument(original, { purpose: 'finance_document' })
    const marked = await oldDocument(original, { scanResult: { sanitized: true } })

    const report = await sanitizer.runScoped([storeId])

    expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    for (const media of [pending, evidence, marked]) {
      expect((await stored(media.key)).equals(original)).toBe(true)
    }
  })

  it('names no store, sweeps no store', async () => {
    await oldDocument(await pdfWithMarkers())

    await expect(sanitizer.runScoped([])).resolves.toEqual({
      cleaned: 0,
      alreadyClean: 0,
      skipped: 0,
      failed: 0
    })
  })
})
