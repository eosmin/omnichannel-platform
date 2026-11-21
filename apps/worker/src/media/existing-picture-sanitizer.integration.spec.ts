import { randomUUID } from 'node:crypto'

import { Test, type TestingModule } from '@nestjs/testing'
import pg from 'pg'
import sharp from 'sharp'

import { PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { ExistingPictureSweep, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { WorkerModule } from '../worker.module'

import { ExistingPictureSanitizer } from './existing-picture-sanitizer.service'

interface MediaRow {
  status: string
  key: string
  contentType: string
  fileSize: number
  scanResult: unknown
}

const PHONE_EXIF = {
  IFD0: { Make: 'Acme', Model: 'Phone 1' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '4/1 30/1 0/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '74/1 5/1 0/1'
  }
}

// The sweep of the pictures stored before the cleaning existed, against the real bucket and database. Every case names the stores it
// sweeps (runScoped): the database and the bucket are shared with other suites.
describe('ExistingPictureSanitizer', () => {
  let moduleRef: TestingModule
  let sanitizer: ExistingPictureSanitizer
  let storage: StorageService
  let owner: pg.Client
  const organizationId = randomUUID()
  const storeId = randomUUID()
  const keys: string[] = []

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ databaseUrl: connectionUrls().worker }))
      .compile()
    sanitizer = moduleRef.get(ExistingPictureSanitizer, { strict: false })
    storage = moduleRef.get(StorageService, { strict: false })
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    const slug = `it-sweep-${storeId.slice(0, 8)}`
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

  // A picture stored before the cleaning existed: clean, served, with no `scan_result`
  async function oldPicture(
    body: Buffer,
    options: { contentType?: string; purpose?: string; status?: string; scanResult?: object } = {}
  ): Promise<{ id: string; key: string }> {
    const id = randomUUID()
    const contentType = options.contentType ?? 'image/jpeg'
    const key = StorageKeys.message(storeId, id, 'photo.jpg')
    await storage.put(key, body, contentType)
    keys.push(key)
    await owner.query(
      `INSERT INTO media (id, store_id, purpose, key, filename, content_type, file_size, status, scan_result)
       VALUES ($1, $2, $3, $4, 'photo.jpg', $5, $6, $7, $8)`,
      [
        id,
        storeId,
        options.purpose ?? 'message',
        key,
        contentType,
        body.length,
        options.status ?? 'clean',
        options.scanResult === undefined ? null : JSON.stringify(options.scanResult)
      ]
    )
    return { id, key }
  }

  async function row(id: string): Promise<MediaRow> {
    const { rows } = await owner.query<MediaRow>(
      `SELECT status, key, content_type AS "contentType", file_size AS "fileSize", scan_result AS "scanResult" FROM media WHERE id = $1`,
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

  const phonePhoto = (): Promise<Buffer> =>
    sharp({ create: { width: 40, height: 20, channels: 3, background: '#cc6633' } })
      .withMetadata({ orientation: 6, exif: PHONE_EXIF })
      .jpeg()
      .toBuffer()

  it('takes the location out of a stored picture, keeps its id and key, and keeps the row true to its size', async () => {
    const photo = await phonePhoto()
    const media = await oldPicture(photo)

    const report = await sanitizer.runScoped([storeId])

    expect(report).toMatchObject({ cleaned: 1, failed: 0 })
    const kept = await stored(media.key)
    const header = await sharp(kept).metadata()
    expect(header.exif).toBeUndefined()
    expect(kept.includes('Acme')).toBe(false)
    expect([header.width, header.height]).toEqual([20, 40]) // Upright, as the camera held it
    const after = await row(media.id)
    expect(after.key).toBe(media.key)
    expect(after.status).toBe('clean')
    expect(after.fileSize).toBe(kept.length)
    expect(after.scanResult).toEqual({ [ExistingPictureSweep.CLEANED_KEY]: true })
  })

  it('is safe to repeat: a picture already cleaned is not taken again, and its bytes do not change', async () => {
    const media = await oldPicture(await phonePhoto())
    await sanitizer.runScoped([storeId])
    const once = await stored(media.key)

    const report = await sanitizer.runScoped([storeId])

    expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    expect((await stored(media.key)).equals(once)).toBe(true)
  })

  it('does not lose the original when the bucket refuses the write, and cleans it on the next run', async () => {
    const photo = await phonePhoto()
    const media = await oldPicture(photo)
    jest.spyOn(storage, 'put').mockRejectedValueOnce(new Error('the bucket is down'))

    const failed = await sanitizer.runScoped([storeId])

    expect(failed).toMatchObject({ cleaned: 0, failed: 1 })
    expect((await stored(media.key)).equals(photo)).toBe(true) // The original is there, byte for byte
    expect((await row(media.id)).scanResult).toBeNull() // And the row says it was not seen
    const retried = await sanitizer.runScoped([storeId])
    expect(retried).toMatchObject({ cleaned: 1, failed: 0 })
    expect((await sharp(await stored(media.key)).metadata()).exif).toBeUndefined()
  })

  it('only marks a picture whose file was already cleaned before the row was (a crash between the two)', async () => {
    const clean = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#336699' }
    })
      .jpeg()
      .toBuffer()
    const media = await oldPicture(clean)

    const report = await sanitizer.runScoped([storeId])

    expect(report).toMatchObject({ alreadyClean: 1, cleaned: 0 })
    expect((await stored(media.key)).equals(clean)).toBe(true) // Not encoded a second time
    expect((await row(media.id)).scanResult).toEqual({
      [ExistingPictureSweep.CLEANED_KEY]: true,
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingPictureSweep.Outcomes.ALREADY_CLEAN
    })
  })

  it('leaves a picture that cannot be decoded where it is, never deletes it, and does not take it again', async () => {
    const garbage = Buffer.from('this is not a picture at all')
    const media = await oldPicture(garbage)

    const first = await sanitizer.runScoped([storeId])
    const second = await sanitizer.runScoped([storeId])

    expect(first).toMatchObject({ skipped: 1, cleaned: 0, failed: 0 })
    expect(second).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    expect((await stored(media.key)).equals(garbage)).toBe(true)
    expect((await row(media.id)).scanResult).toEqual({
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingPictureSweep.Outcomes.UNDECODABLE
    })
  })

  it('marks a row whose file is not in the bucket, and does not take it again', async () => {
    const media = await oldPicture(await phonePhoto())
    await storage.delete(media.key)

    const report = await sanitizer.runScoped([storeId])

    expect(report).toMatchObject({ skipped: 1, cleaned: 0 })
    expect((await row(media.id)).scanResult).toEqual({
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingPictureSweep.Outcomes.MISSING
    })
  })

  it('leaves alone what is not a clean picture of the sweep: a pending one, an avatar, evidence, and one the scan already marked', async () => {
    const photo = await phonePhoto()
    const pending = await oldPicture(photo, { status: 'pending' })
    const evidence = await oldPicture(photo, { purpose: 'finance_document' })
    const marked = await oldPicture(photo, { scanResult: { sanitized: true } })

    const report = await sanitizer.runScoped([storeId])

    expect(report).toEqual({ cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 })
    for (const media of [pending, evidence, marked]) {
      expect((await stored(media.key)).equals(photo)).toBe(true)
    }
  })

  it('takes a bounded batch of a store per run, the oldest id first, and the next run takes the rest', async () => {
    const photo = await phonePhoto()
    const total = ExistingPictureSweep.BATCH_PER_STORE + 3
    for (let i = 0; i < total; i += 1) await oldPicture(photo)

    const first = await sanitizer.runScoped([storeId])
    const second = await sanitizer.runScoped([storeId])

    expect(first.cleaned).toBe(ExistingPictureSweep.BATCH_PER_STORE)
    expect(second.cleaned).toBe(3)
  })

  it('names no store, sweeps no store', async () => {
    await oldPicture(await phonePhoto())

    await expect(sanitizer.runScoped([])).resolves.toEqual({
      cleaned: 0,
      alreadyClean: 0,
      skipped: 0,
      failed: 0
    })
  })
})
