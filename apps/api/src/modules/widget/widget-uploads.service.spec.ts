import type { Redis } from 'ioredis'

import { ErrorCodes } from '@platform/core/errors'
import type { StorageService } from '@platform/core/storage-module'

import type { WidgetSite } from './widget-sites.service'
import { WidgetUploads } from './widget-uploads.service'

const site = { siteKey: 'pk_widget_AAAAAAAAAAAAAAAAAAAAAAAA', storeId: 'store-1' } as WidgetSite
const visitor = '3f2c1a9e-4b7d-4c1e-9a55-0d1e2f3a4b5c'
const other = '4a3d2b0f-5c8e-4d2f-8b66-1e2f3a4b5c6d'
const png = { filename: 'foto.png', contentType: 'image/png', fileSizeBytes: 1000 }

// Only what the service uses: strings with expiry and NX, and the quota script
function fakeRedis(): Redis & { values: Map<string, string> } {
  const values = new Map<string, string>()
  const counts = new Map<string, number>()
  return {
    values,
    get: jest.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    set: jest.fn((key: string, value: string, ...flags: string[]) => {
      if (flags.includes('NX') && values.has(key)) return Promise.resolve(null)
      values.set(key, value)
      return Promise.resolve('OK')
    }),
    del: jest.fn((key: string) => Promise.resolve(values.delete(key) ? 1 : 0)),
    eval: jest.fn((_script: string, _n: number, key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return Promise.resolve(counts.get(key))
    })
  } as unknown as Redis & { values: Map<string, string> }
}

describe('WidgetUploads', () => {
  let redis: ReturnType<typeof fakeRedis>
  let storage: { uploadUrl: jest.Mock; head: jest.Mock }
  let uploads: WidgetUploads

  beforeEach(() => {
    redis = fakeRedis()
    storage = {
      uploadUrl: jest.fn().mockResolvedValue('https://bucket.test/put'),
      head: jest.fn()
    }
    uploads = new WidgetUploads(storage as unknown as StorageService, redis)
  })

  describe('requestUrl', () => {
    it('signs a url for a staging key of the store and records who asked', async () => {
      const result = await uploads.requestUrl(site, visitor, { visitorToken: 't', ...png })

      expect(result.uploadUrl).toBe('https://bucket.test/put')
      expect(storage.uploadUrl).toHaveBeenCalledWith({
        key: `stores/store-1/uploads/${result.uploadId}/foto.png`,
        contentType: 'image/png',
        contentLength: 1000
      })
      const record = JSON.parse(
        redis.values.get(`store:store-1:widget-upload:${result.uploadId}`) ?? '{}'
      ) as Record<string, unknown>
      expect(record).toMatchObject({
        visitorId: visitor,
        filename: 'foto.png',
        fileSizeBytes: 1000
      })
    })

    it('cleans the name the visitor gave', async () => {
      const result = await uploads.requestUrl(site, visitor, {
        visitorToken: 't',
        ...png,
        filename: '../../etc/pass wd.png'
      })
      const key = (storage.uploadUrl.mock.calls[0] as [{ key: string }])[0].key
      expect(key.startsWith(`stores/store-1/uploads/${result.uploadId}/`)).toBe(true)
      // One segment after the upload id: the slashes of the name are gone
      expect(key.slice(`stores/store-1/uploads/${result.uploadId}/`.length)).not.toContain('/')
    })

    it('refuses a type that is not allowed and a file that is too big, and signs nothing', async () => {
      await expect(
        uploads.requestUrl(site, visitor, { visitorToken: 't', ...png, contentType: 'text/html' })
      ).rejects.toMatchObject({ code: ErrorCodes.FILE_TYPE_NOT_ALLOWED })
      await expect(
        uploads.requestUrl(site, visitor, {
          visitorToken: 't',
          ...png,
          fileSizeBytes: 11 * 1024 * 1024
        })
      ).rejects.toMatchObject({ code: ErrorCodes.FILE_TOO_LARGE })
      expect(storage.uploadUrl).not.toHaveBeenCalled()
    })

    it('stops a visitor at the hourly cap', async () => {
      for (let i = 0; i < 20; i++) {
        await uploads.requestUrl(site, visitor, { visitorToken: 't', ...png })
      }
      await expect(
        uploads.requestUrl(site, visitor, { visitorToken: 't', ...png })
      ).rejects.toMatchObject({ code: ErrorCodes.RATE_LIMIT_EXCEEDED })
      // Another visitor of the same site is not stopped by it
      await expect(
        uploads.requestUrl(site, other, { visitorToken: 't', ...png })
      ).resolves.toBeDefined()
    })
  })

  describe('attachmentsOf', () => {
    async function signed(who = visitor): Promise<string> {
      const { uploadId } = await uploads.requestUrl(site, who, { visitorToken: 't', ...png })
      storage.head.mockResolvedValue({ contentLength: 1000, contentType: 'image/png' })
      return uploadId
    }

    it('answers with the name and type that were signed, whatever the message says', async () => {
      const id = await signed()
      await expect(uploads.attachmentsOf(site, visitor, 'm1', [id])).resolves.toEqual([
        { id, filename: 'foto.png', contentType: 'image/png' }
      ])
    })

    it('takes the same message again, and one upload once per list', async () => {
      const id = await signed()
      await uploads.attachmentsOf(site, visitor, 'm1', [id, id])
      await expect(uploads.attachmentsOf(site, visitor, 'm1', [id])).resolves.toHaveLength(1)
    })

    it('claims nothing when one of the files fails, so the next message can carry the others', async () => {
      const good = await signed()
      await expect(
        uploads.attachmentsOf(site, visitor, 'm1', [good, '8b1f6a3c-52d4-4e5a-9a3b-7c1d2e3f4a5b'])
      ).rejects.toMatchObject({ code: ErrorCodes.FILE_UPLOAD_FAILED })

      await expect(uploads.attachmentsOf(site, visitor, 'm2', [good])).resolves.toHaveLength(1)
    })

    it('frees the files of a message that was not taken, only for the message that holds them', async () => {
      const id = await signed()
      await uploads.attachmentsOf(site, visitor, 'm1', [id])

      await uploads.release(site.storeId, [id], 'other')
      await expect(uploads.attachmentsOf(site, visitor, 'm2', [id])).rejects.toBeDefined()
      await uploads.release(site.storeId, [id], 'm1')
      await expect(uploads.attachmentsOf(site, visitor, 'm2', [id])).resolves.toHaveLength(1)
    })

    it('refuses an upload that another message already carries', async () => {
      const id = await signed()
      await uploads.attachmentsOf(site, visitor, 'm1', [id])
      await expect(uploads.attachmentsOf(site, visitor, 'm2', [id])).rejects.toMatchObject({
        code: ErrorCodes.FILE_UPLOAD_FAILED
      })
    })

    it('refuses the upload of another visitor, one that was never made and one never put', async () => {
      const mine = await signed(other)
      await expect(uploads.attachmentsOf(site, visitor, 'm1', [mine])).rejects.toMatchObject({
        code: ErrorCodes.FILE_UPLOAD_FAILED
      })
      await expect(
        uploads.attachmentsOf(site, visitor, 'm1', ['8b1f6a3c-52d4-4e5a-9a3b-7c1d2e3f4a5b'])
      ).rejects.toMatchObject({ code: ErrorCodes.FILE_UPLOAD_FAILED })
      const id = await signed()
      storage.head.mockResolvedValue(null)
      await expect(uploads.attachmentsOf(site, visitor, 'm1', [id])).rejects.toMatchObject({
        code: ErrorCodes.FILE_UPLOAD_FAILED
      })
    })

    it('refuses an object that is not the size or the type that was signed', async () => {
      const id = await signed()
      storage.head.mockResolvedValue({ contentLength: 5_000_000, contentType: 'image/png' })
      await expect(uploads.attachmentsOf(site, visitor, 'm1', [id])).rejects.toMatchObject({
        code: ErrorCodes.FILE_UPLOAD_FAILED
      })
      storage.head.mockResolvedValue({ contentLength: 1000, contentType: 'text/html' })
      await expect(uploads.attachmentsOf(site, visitor, 'm1', [id])).rejects.toMatchObject({
        code: ErrorCodes.FILE_UPLOAD_FAILED
      })
    })

    it('does not read an upload recorded for another store', async () => {
      const id = await signed()
      const elsewhere = { ...site, storeId: 'store-2' }
      await expect(uploads.attachmentsOf(elsewhere, visitor, 'm1', [id])).rejects.toMatchObject({
        code: ErrorCodes.FILE_UPLOAD_FAILED
      })
    })
  })
})
