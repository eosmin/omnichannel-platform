import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import { Test, type TestingModule } from '@nestjs/testing'
import { type Queue, UnrecoverableError } from 'bullmq'
import pg from 'pg'
import sharp from 'sharp'

import { PrismaService } from '@platform/core/database'
import { connectionUrls, workerRoleBoundInSuites } from '@platform/core/database-testing'
import { JobNames, QueueNames } from '@platform/core/queues'
import { AnimatedImage, ImageVariants, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { dropJob } from '../testing/drop-job'
import { WorkerModule } from '../worker.module'

import { ClamavClient } from './clamav.client'
import { DocumentCleaner } from './document-cleaner'
import { MediaPipeline } from './media-pipeline.service'
import { InlineDocumentCleaner } from './testing/inline-document-cleaner'

// The standard antivirus test string: every scanner flags it, and it is harmless
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

interface MediaRow {
  status: string
  key: string
  filename: string
  storeId: string | null
  contentType: string
  fileSize: number
  variants: unknown
  scanResult: unknown
  scannedAt: Date | null
  processedAt: Date | null
}

// The scan and the variants against the real daemon, bucket and database: the chain of a file from
// `pending` to something that may be served, or to nothing.
describe('MediaPipeline', () => {
  let moduleRef: TestingModule
  let pipeline: MediaPipeline
  let storage: StorageService
  let heavy: Queue
  let owner: pg.Client
  const organizationId = randomUUID()
  const storeId = randomUUID()
  const keys: string[] = []

  // Reads the row the way the owner of the database sees it, never through the connection of the worker: with the policies enforced
  // that one sees a row only inside the context of its store, and what is checked here is the row, not the context
  async function readMedia(id: string): Promise<MediaRow> {
    const { rows } = await owner.query<MediaRow>(
      `SELECT status, key, filename, store_id AS "storeId", content_type AS "contentType", file_size AS "fileSize", variants,
              scan_result AS "scanResult", scanned_at AS "scannedAt", processed_at AS "processedAt"
         FROM media WHERE id = $1`,
      [id]
    )
    const row = rows[0]
    if (row === undefined) throw new Error(`the media ${id} has no row`)
    return row
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      // The role of the worker, at the address of the run: the env file holds the one of a laptop
      // The thread is a file of the bundle (`document-thread.js`), which a run under ts-jest does not have: it is checked on the built bundle
      // by `scripts/smoke-document-thread.ts` (CI), and its behavior by `thread-document-cleaner.spec.ts`
      .overrideProvider(DocumentCleaner)
      .useValue(new InlineDocumentCleaner())
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ databaseUrl: connectionUrls().worker }))
      .compile()
    pipeline = moduleRef.get(MediaPipeline, { strict: false })
    storage = moduleRef.get(StorageService, { strict: false })
    heavy = moduleRef.get(getQueueToken(QueueNames.HEAVY_PROCESSING), { strict: false })
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    const slug = `it-media-${storeId.slice(0, 8)}`
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
    // Removing the organization removes the store and its media (cascade)
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [organizationId])
    await owner.end()
    await moduleRef.close()
  })

  async function pendingMedia(
    filename: string,
    contentType: string,
    body: Buffer
  ): Promise<{ id: string; key: string }> {
    const id = randomUUID()
    const key = StorageKeys.message(storeId, id, filename)
    await storage.put(key, body, contentType)
    keys.push(
      key,
      ...Object.values(ImageVariants).map(variant =>
        StorageKeys.messageVariant(storeId, id, variant)
      )
    )
    // As the owner: the role of the worker reads and updates media, it never creates it
    await owner.query(
      `INSERT INTO media (id, store_id, purpose, key, filename, content_type, file_size, status)
       VALUES ($1, $2, 'message', $3, $4, $5, $6, 'pending')`,
      [id, storeId, key, filename, contentType, body.length]
    )
    return { id, key }
  }

  const png = (width: number, height: number): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
      .png()
      .toBuffer()

  it('marks a clean image clean and queues its variants once', async () => {
    const media = await pendingMedia('photo.png', 'image/png', await png(3000, 2000))

    await pipeline.scan(media.id, { storeId })
    // A repeated job (a retry after the first attempt died late) changes nothing
    await pipeline.scan(media.id, { storeId })

    const row = await readMedia(media.id)
    expect(row.status).toBe('clean')
    expect(row.scannedAt).not.toBeNull()
    const queued = await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)
    expect(queued?.data).toEqual({ mediaId: media.id, storeId })
    await dropJob(queued)
  })

  describe('metadata of a picture', () => {
    // A photo as a phone makes it: held on its side, with where it was taken
    const phonePhoto = (): Promise<Buffer> =>
      sharp({ create: { width: 40, height: 20, channels: 3, background: '#cc6633' } })
        .withMetadata({
          orientation: 6,
          exif: {
            IFD0: { Make: 'Acme', Model: 'Phone 1' },
            IFD3: {
              GPSLatitudeRef: 'N',
              GPSLatitude: '4/1 30/1 0/1',
              GPSLongitudeRef: 'W',
              GPSLongitude: '74/1 5/1 0/1'
            }
          }
        })
        .jpeg()
        .toBuffer()

    async function stored(key: string): Promise<Buffer> {
      const body = await storage.read(key, 10 * 1024 * 1024)
      if (body === null) throw new Error('the file is not in the bucket')
      return body
    }

    it('keeps the stored file upright and without location, and the row true to its size', async () => {
      const photo = await phonePhoto()
      expect((await sharp(photo).metadata()).exif).toBeDefined()
      const media = await pendingMedia('photo.jpg', 'image/jpeg', photo)

      await pipeline.scan(media.id, { storeId })

      const row = await readMedia(media.id)
      expect(row.status).toBe('clean')
      const kept = await stored(media.key)
      const header = await sharp(kept).metadata()
      expect(header.exif).toBeUndefined()
      expect(header.orientation).toBeUndefined()
      expect(kept.includes('Acme')).toBe(false)
      expect([header.width, header.height]).toEqual([20, 40]) // Turned upright, as the camera held it
      expect(row.fileSize).toBe(kept.length)
      expect(row.contentType).toBe('image/jpeg')
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
    })

    it('does not encode the picture again when the scan is tried again', async () => {
      const media = await pendingMedia('photo.jpg', 'image/jpeg', await phonePhoto())
      await pipeline.scan(media.id, { storeId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
      const first = await stored(media.key)
      // As after a verdict that never came: the row is pending again and the scan runs once more
      await owner.query(`UPDATE media SET status = 'pending' WHERE id = $1`, [media.id])

      await pipeline.scan(media.id, { storeId })

      expect((await stored(media.key)).equals(first)).toBe(true)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
    })

    it('settles the row and tells the team even when the refused file cannot be deleted', async () => {
      const media = await pendingMedia('broken.jpg', 'image/jpeg', Buffer.alloc(300, 0x41))
      const remove = jest.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('bucket down'))

      await pipeline.scan(media.id, { storeId })

      remove.mockRestore()
      const row = await readMedia(media.id)
      expect(row.status).toBe('unscannable') // The hourly cleanup removes the file of such a row
      expect(row.scanResult).toEqual({ reason: 'image_not_sanitizable' })
    })

    it('refuses a picture it cannot decode: no file kept, its own reason, nothing queued', async () => {
      const photo = await phonePhoto()
      const media = await pendingMedia(
        'broken.jpg',
        'image/jpeg',
        Buffer.concat([photo.subarray(0, 60), Buffer.alloc(300, 0x41)])
      )

      await pipeline.scan(media.id, { storeId })

      const row = await readMedia(media.id)
      expect(row.status).toBe('unscannable')
      expect(row.scanResult).toEqual({ reason: 'image_not_sanitizable' })
      expect(await storage.head(media.key)).toBeNull() // The original, with its metadata, is gone
      expect(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)).toBeUndefined()
    })

    // The scan comes first, on the bytes that were sent. The test string is detected only at the start
    // of a file (ClamAV anchors it), so it stands for the whole file here: were the decoder first, a
    // file that is not a picture would be refused as `unscannable` and the virus would go unreported.
    it('reports a virus before the decoder sees the file', async () => {
      for (const [filename, contentType] of [
        ['virus.jpg', 'image/jpeg'],
        ['virus.png', 'image/png'],
        ['virus.webp', 'image/webp']
      ] as const) {
        const media = await pendingMedia(filename, contentType, Buffer.from(EICAR))

        await pipeline.scan(media.id, { storeId })

        const row = await readMedia(media.id)
        expect([filename, row.status]).toEqual([filename, 'infected'])
        expect(row.scanResult).toEqual({ viruses: [expect.stringContaining('Eicar')] })
        expect(await storage.head(media.key)).toBeNull()
        expect(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)).toBeUndefined()
      }
    })

    it('keeps the picture pending, never served, until it is cleaned', async () => {
      const media = await pendingMedia('photo.jpg', 'image/jpeg', await phonePhoto())
      let seenWhileCleaning: string | undefined
      const put = storage.put.bind(storage)
      const spy = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
        seenWhileCleaning = (await readMedia(media.id)).status
        await put(...args)
      })

      await pipeline.scan(media.id, { storeId })

      spy.mockRestore()
      expect(seenWhileCleaning).toBe('pending')
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
    })

    it('refuses a decompression bomb before decoding it', async () => {
      const bomb = await sharp({
        create: { width: 12000, height: 12000, channels: 3, background: '#000' }
      })
        .png({ compressionLevel: 9 })
        .toBuffer()
      const media = await pendingMedia('bomb.png', 'image/png', bomb)

      await pipeline.scan(media.id, { storeId })

      const row = await readMedia(media.id)
      expect(row.status).toBe('unscannable')
      expect(row.scanResult).toEqual({ reason: 'image_not_sanitizable' })
      expect(await storage.head(media.key)).toBeNull()
    }, 60_000)

    it('cuts the comment out of a gif and keeps its frames', async () => {
      const frames = Buffer.concat(
        ['#f00', '#00f'].map(colour => Buffer.alloc(8 * 8 * 3, colour === '#f00' ? 0xf0 : 0x0f))
      )
      const gif = await sharp(frames, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } })
        .gif()
        .toBuffer()
      const flags = gif[10] ?? 0
      const at = 13 + ((flags & 0x80) === 0 ? 0 : 3 * 2 ** ((flags & 0x07) + 1))
      const secret = 'taken at 4.6,-74.0 by Jane'
      const comment = Buffer.concat([
        Buffer.from([0x21, 0xfe, secret.length]),
        Buffer.from(secret),
        Buffer.from([0])
      ])
      const dirty = Buffer.concat([gif.subarray(0, at), comment, gif.subarray(at)])
      const media = await pendingMedia('moving.gif', 'image/gif', dirty)

      await pipeline.scan(media.id, { storeId })

      const body = await stored(media.key)
      expect(body.includes(secret)).toBe(false)
      expect((await sharp(body, { animated: true }).metadata()).pages).toBe(2)
      const row = await readMedia(media.id)
      expect(row.status).toBe('clean')
      expect(row.fileSize).toBe(body.length)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
    })

    it('does not touch an animation', async () => {
      const frames = Buffer.concat(
        ['#f00', '#00f'].map(colour => Buffer.alloc(8 * 8 * 3, colour === '#f00' ? 0xf0 : 0x0f))
      )
      const gif = await sharp(frames, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } })
        .gif()
        .toBuffer()
      const media = await pendingMedia('moving.gif', 'image/gif', gif)

      await pipeline.scan(media.id, { storeId })

      expect((await stored(media.key)).equals(gif)).toBe(true)
      const row = await readMedia(media.id)
      expect(row.status).toBe('clean')
      expect(row.fileSize).toBe(gif.length)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
    })
  })

  it('deletes an infected file and never serves it', async () => {
    const media = await pendingMedia('invoice.txt', 'text/plain', Buffer.from(EICAR))

    await pipeline.scan(media.id, { storeId })

    const row = await readMedia(media.id)
    expect(row.status).toBe('infected')
    expect(row.scanResult).toEqual({ viruses: [expect.stringContaining('Eicar')] })
    expect(await storage.head(media.key)).toBeNull()
    expect(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)).toBeUndefined()
  })

  it('does not queue variants for a file that is not an image', async () => {
    const media = await pendingMedia('notes.txt', 'text/plain', Buffer.from('plain text'))

    await pipeline.scan(media.id, { storeId })

    expect((await readMedia(media.id)).status).toBe('clean')
    expect(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)).toBeUndefined()
  })

  it('makes the three WebP variants of a clean image and keeps their keys', async () => {
    const media = await pendingMedia('photo.png', 'image/png', await png(3000, 2000))
    await pipeline.scan(media.id, { storeId })
    await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))

    await pipeline.processImage(media.id, { storeId })

    const row = await readMedia(media.id)
    expect(row.processedAt).not.toBeNull()
    expect(row.variants).toEqual({
      full: StorageKeys.messageVariant(storeId, media.id, 'full'),
      medium: StorageKeys.messageVariant(storeId, media.id, 'medium'),
      thumb: StorageKeys.messageVariant(storeId, media.id, 'thumb')
    })
    const size = async (variant: 'full' | 'medium' | 'thumb') => {
      const bytes = await storage.read(StorageKeys.messageVariant(storeId, media.id, variant), 5e6)
      const meta = await sharp(bytes ?? Buffer.alloc(0)).metadata()
      return [meta.format, meta.width, meta.height]
    }
    expect(await size('full')).toEqual(['webp', 2000, 1333])
    expect(await size('medium')).toEqual(['webp', 800, 533])
    expect(await size('thumb')).toEqual(['webp', 160, 160])
  })

  it('leaves the image as it is when it cannot be decoded, and says it is settled', async () => {
    // A gif is not re-encoded by the cleaning of metadata (that would flatten it): its blocks are walked and copied. One whose
    // blocks are in order but whose pixel data is garbage passes the cleaning and gets to the variants; one that cannot be
    // walked is refused earlier, at the scan
    const good = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
      .gif()
      .toBuffer()
    const garbage = Buffer.from(good)
    garbage.fill(0xff, garbage.length - 7, garbage.length - 3)
    const media = await pendingMedia('broken.gif', 'image/gif', garbage)
    await pipeline.scan(media.id, { storeId })
    await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))

    // Unrecoverable: the queue must not try a file the decoder refuses a second time
    const failure = await pipeline
      .processImage(media.id, { storeId })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UnrecoverableError)
    expect((failure as Error).message).toContain('could not be processed')

    const row = await readMedia(media.id)
    expect(row.status).toBe('clean')
    expect(row.variants).toBeNull()
    // Settled with no variant: the thread draws a download, not a placeholder that never ends, and the
    // hourly cleanup does not queue the same refused file again
    expect(row.processedAt).not.toBeNull()
  })

  // A sticker or a gif: n frames of the same size, as the file a customer sends
  const animation = (frames: number, size: number, format: 'webp' | 'gif'): Promise<Buffer> =>
    Promise.all(
      Array.from({ length: frames }, (_, i) =>
        sharp({
          // Every frame differs from the one before: an encoder merges equal neighbours into one
          create: {
            width: size,
            height: size,
            channels: 3,
            background: { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256 }
          }
        })
          .png()
          .toBuffer()
      )
    ).then(images =>
      sharp(images, { join: { animated: true } })
        .toFormat(format, { loop: 0, delay: Array<number>(frames).fill(80) })
        .toBuffer()
    )

  const variantMeta = async (mediaId: string, variant: 'full' | 'medium' | 'thumb') => {
    const bytes = await storage.read(StorageKeys.messageVariant(storeId, mediaId, variant), 5e6)
    const meta = await sharp(bytes ?? Buffer.alloc(0)).metadata()
    return { format: meta.format, pages: meta.pages, width: meta.width, height: meta.height }
  }

  async function processed(filename: string, contentType: string, body: Buffer) {
    const media = await pendingMedia(filename, contentType, body)
    await pipeline.scan(media.id, { storeId })
    await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
    await pipeline.processImage(media.id, { storeId })
    return media
  }

  it.each([
    ['sticker.webp', 'image/webp', 'webp'],
    ['funny.gif', 'image/gif', 'gif']
  ] as const)(
    'keeps the animation of %s in the big variants and draws the thumb still',
    async (filename, contentType, format) => {
      const media = await processed(filename, contentType, await animation(12, 600, format))

      expect(await variantMeta(media.id, 'full')).toMatchObject({ format: 'webp', pages: 12 })
      expect(await variantMeta(media.id, 'medium')).toMatchObject({
        format: 'webp',
        pages: 12,
        width: 600
      })
      expect(await variantMeta(media.id, 'thumb')).toMatchObject({ width: 160, height: 160 })
      expect((await variantMeta(media.id, 'thumb')).pages).toBeUndefined()
    }
  )

  it('draws an animation with more frames than the cap from its first frame, and keeps the original', async () => {
    const media = await processed(
      'long.gif',
      'image/gif',
      await animation(AnimatedImage.MAX_FRAMES + 1, 16, 'gif')
    )

    for (const variant of ['full', 'medium', 'thumb'] as const) {
      expect((await variantMeta(media.id, variant)).pages).toBeUndefined()
    }
    expect(await storage.head(media.key)).not.toBeNull()
  })

  it('draws an animation whose frames hold too many pixels together from its first frame', async () => {
    // 60 frames of 800 x 800 is 38 million pixels: under the frame cap, over the pixel budget
    const media = await processed('big.gif', 'image/gif', await animation(60, 800, 'gif'))

    expect((await variantMeta(media.id, 'full')).pages).toBeUndefined()
    expect(await variantMeta(media.id, 'full')).toMatchObject({ format: 'webp', width: 800 })
  })

  it('draws an animation that carries a quarter-turn orientation from its first frame, not refused', async () => {
    // The encoder cannot rotate the frames of an animation: it throws if asked to. The rule of
    // `keepsAnimation` (unit tested) keeps it from being asked, and the still fallback of `processImage`
    // would catch it if it were: this case proves the end result, whichever of the two did the work.
    const rotated = await sharp(await animation(6, 40, 'webp'), { animated: true })
      .withMetadata({ orientation: 6 })
      .webp({ loop: 0 })
      .toBuffer()
    // The cleaning of the scan would cut that orientation (it is EXIF), so the bytes are put in the bucket after it: the case is a
    // picture stored before the cleaning existed
    const media = await pendingMedia('turned.webp', 'image/webp', await animation(6, 40, 'webp'))
    await pipeline.scan(media.id, { storeId })
    await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))
    await storage.put(media.key, rotated, 'image/webp')
    await pipeline.processImage(media.id, { storeId })

    const row = await readMedia(media.id)
    expect(row.variants).not.toBeNull()
    expect((await variantMeta(media.id, 'full')).pages).toBeUndefined()
    // Turned a quarter, as a still: the frames were 40 x 40, so the shape does not tell, the pages do
    expect(await variantMeta(media.id, 'full')).toMatchObject({ format: 'webp' })
  })

  it('does not change a still webp', async () => {
    const still = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#33cc66' }
    })
      .webp()
      .toBuffer()
    const media = await processed('still.webp', 'image/webp', still)

    expect((await variantMeta(media.id, 'full')).pages).toBeUndefined()
  })

  describe('a scan with no verdict', () => {
    let clamav: ClamavClient
    beforeEach(() => {
      clamav = moduleRef.get(ClamavClient, { strict: false })
      jest.spyOn(clamav, 'scan').mockRejectedValue(new Error('the daemon is down'))
    })
    afterEach(() => jest.restoreAllMocks())

    it('stays pending while the job has tries left, so the queue retries it', async () => {
      const media = await pendingMedia('retry.txt', 'text/plain', Buffer.from('plain text'))

      await expect(pipeline.scan(media.id, { storeId }, false)).rejects.toThrow(
        'the daemon is down'
      )

      const row = await readMedia(media.id)
      expect(row.status).toBe('pending')
      expect(await storage.head(media.key)).not.toBeNull()
    })

    it('is given up on the last try: terminal row, file gone, error still raised', async () => {
      const media = await pendingMedia('lost.txt', 'text/plain', Buffer.from('plain text'))

      await expect(pipeline.scan(media.id, { storeId }, true)).rejects.toThrow('the daemon is down')

      const row = await readMedia(media.id)
      expect(row.status).toBe('unscannable')
      expect(row.scannedAt).not.toBeNull()
      expect(await storage.head(media.key)).toBeNull()
      // Past its state: a later job does nothing, not even ask the daemon
      await expect(pipeline.scan(media.id, { storeId }, true)).resolves.toBeUndefined()
    })
  })

  // The picture of a person: no store, and never served as it was uploaded
  describe('an avatar', () => {
    const userIds: string[] = []
    afterEach(async () => {
      const ids = userIds.splice(0)
      await owner.query(`DELETE FROM media WHERE uploaded_by = ANY($1)`, [ids])
      await owner.query(`DELETE FROM users WHERE id = ANY($1)`, [ids])
    })

    // A photo that carries metadata, which is what must not reach the people who see the picture
    const photoWithMetadata = (): Promise<Buffer> =>
      sharp({ create: { width: 800, height: 400, channels: 3, background: '#cc6633' } })
        .withExif({ IFD0: { ImageDescription: 'taken at 19.4326,-99.1332' } })
        .jpeg()
        .toBuffer()

    async function pendingAvatar(body: Buffer, contentType = 'image/jpeg') {
      const userId = randomUUID()
      const id = randomUUID()
      userIds.push(userId)
      await owner.query(
        `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
        [userId, `it-avatar-${userId}@example.com`]
      )
      const key = StorageKeys.avatar(userId, id, 'me.jpg')
      await storage.put(key, body, contentType)
      keys.push(key, StorageKeys.avatarImage(userId, id))
      await owner.query(
        `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status)
         VALUES ($1, NULL, 'avatar', $2, $3, 'me.jpg', $4, $5, 'pending')`,
        [id, userId, key, contentType, body.length]
      )
      return { id, userId, key }
    }

    it('is scanned, then re-encoded to a small square WebP with no metadata, and the upload goes', async () => {
      const original = await photoWithMetadata()
      expect((await sharp(original).metadata()).exif).toBeDefined()
      const avatar = await pendingAvatar(original)

      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await pipeline.processImage(avatar.id, { userId: avatar.userId })

      const row = await readMedia(avatar.id)
      const served = StorageKeys.avatarImage(avatar.userId, avatar.id)
      expect(row).toMatchObject({
        status: 'clean',
        key: served,
        filename: 'avatar.webp',
        contentType: 'image/webp',
        storeId: null
      })
      expect(row.processedAt).not.toBeNull()
      const bytes = await storage.read(served, 5e6)
      const meta = await sharp(bytes ?? Buffer.alloc(0)).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 256, 256])
      expect(meta.exif).toBeUndefined()
      expect(bytes?.length).toBe(row.fileSize)
      expect(await storage.head(avatar.key)).toBeNull()
    })

    it('is processed once: a repeated job changes nothing', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await pipeline.processImage(avatar.id, { userId: avatar.userId })
      const first = await readMedia(avatar.id)

      await pipeline.processImage(avatar.id, { userId: avatar.userId })

      const again = await readMedia(avatar.id)
      expect(again.processedAt).toEqual(first.processedAt)
    })

    it('is refused for good when it cannot be re-encoded: never served, file gone', async () => {
      const avatar = await pendingAvatar(Buffer.from('not an image'))
      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))

      await expect(
        pipeline.processImage(avatar.id, { userId: avatar.userId })
      ).resolves.toBeUndefined()

      const row = await readMedia(avatar.id)
      expect(row.status).toBe('unscannable')
      expect(row.processedAt).toBeNull()
      expect(await storage.head(avatar.key)).toBeNull()
    })

    it('leaves nothing behind when the person replaced it while it was processed', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      // The person's replacement deletes the row after the worker read it and before it wrote
      const put = storage.put.bind(storage)
      const spy = jest.spyOn(storage, 'put').mockImplementationOnce(async (...args) => {
        await put(...args)
        await owner.query(`DELETE FROM media WHERE id = $1`, [avatar.id])
      })
      try {
        await pipeline.processImage(avatar.id, { userId: avatar.userId })
      } finally {
        spy.mockRestore()
      }

      expect(await storage.head(StorageKeys.avatarImage(avatar.userId, avatar.id))).toBeNull()
    })

    it('is not processed when its key is not under its own user', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      // The row stays the user's own (uploaded_by) and visible to the context of that user; its key points at the files of ANOTHER user
      const foreignKey = StorageKeys.avatar(randomUUID(), avatar.id, 'me.jpg')
      await owner.query(`UPDATE media SET key = $2 WHERE id = $1`, [avatar.id, foreignKey])

      await pipeline.processImage(avatar.id, { userId: avatar.userId })

      const row = await readMedia(avatar.id)
      expect(row.processedAt).toBeNull()
      expect(row.status).toBe('unscannable')
    })

    it('with no uploader the row is hidden from the user scope when the worker role is bound, and refused when it is not', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await owner.query(`UPDATE media SET uploaded_by = NULL WHERE id = $1`, [avatar.id])

      await pipeline.processImage(avatar.id, { userId: avatar.userId })

      const row = await readMedia(avatar.id)
      expect(row.processedAt).toBeNull()
      // Worker role BOUND (WORKER_RLS_CONTEXT=true, no BYPASSRLS): row security hides the row from the user scope, so there is no row
      // to refuse and nothing changes. With the bypass the row is seen and the guard by key refuses it. Never processed in both
      expect(row.status).toBe(workerRoleBoundInSuites() ? 'clean' : 'unscannable')
    })

    it('fails (to be tried again) when its file is missing but the row is there', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await storage.delete(avatar.key)

      await expect(pipeline.processImage(avatar.id, { userId: avatar.userId })).rejects.toThrow(
        'not in the bucket'
      )
    })

    it('is refused when it declares more pixels than an avatar needs', async () => {
      const huge = await sharp({
        create: { width: 6000, height: 5000, channels: 3, background: '#000' }
      })
        .png({ compressionLevel: 9 })
        .toBuffer()
      const avatar = await pendingAvatar(huge, 'image/png')
      await pipeline.scan(avatar.id, { userId: avatar.userId })
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))

      await pipeline.processImage(avatar.id, { userId: avatar.userId })

      const row = await readMedia(avatar.id)
      expect(row.status).toBe('unscannable')
    })
  })

  it('does nothing for a media that was deleted or is not pending', async () => {
    await expect(pipeline.scan(randomUUID(), { storeId })).resolves.toBeUndefined()
    await expect(pipeline.processImage(randomUUID(), { storeId })).resolves.toBeUndefined()
  })
})
