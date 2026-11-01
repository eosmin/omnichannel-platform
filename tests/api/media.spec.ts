import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { MediaStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { JobNames, QueueNames } from '@platform/core/queues'
import { StorageKeys, UploadLimits } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

interface UploadUrlBody {
  uploadUrl: string
  key: string
  mediaId: string
}
interface MediaBody {
  id: string
  purpose: string
  filename: string
  contentType: string
  fileSize: number
  status: string
}
interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}

const OK = 200
const BAD_REQUEST = 400
const INTERNAL_SERVER_ERROR = 500
const UNAUTHORIZED = 401
const FORBIDDEN = 403

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe('Media upload', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const mediaIds = new Set<string>()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    // The objects of the suite: the bucket is shared, and a row is not the only thing it leaves
    const storage = app.get(StorageService, { strict: false })
    await Promise.all(
      [...mediaIds].flatMap(id => [
        storage.delete(StorageKeys.messageUpload(ctx.storeA.id, id, 'photo.png')),
        storage.delete(StorageKeys.message(ctx.storeA.id, id, 'photo.png'))
      ])
    )
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const scans = () =>
    queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.filter(job => job.name === JobNames.SCAN_FILE)

  const requestUpload = async (overrides: Record<string, unknown> = {}) => {
    const response = await asAgent()
      .post(ApiRoutes.media.uploadUrl)
      .send({
        purpose: 'message',
        filename: 'photo.png',
        contentType: 'image/png',
        fileSizeBytes: PNG.length,
        ...overrides
      })
    return response
  }

  const put = (url: string, body: Buffer, contentType = 'image/png', length = body.length) =>
    fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'content-length': String(length) },
      body: new Uint8Array(body)
    })

  const confirmBody = (upload: UploadUrlBody, overrides: Record<string, unknown> = {}) => ({
    mediaId: upload.mediaId,
    key: upload.key,
    purpose: 'message',
    filename: 'photo.png',
    contentType: 'image/png',
    fileSizeBytes: PNG.length,
    ...overrides
  })

  // An uploaded, confirmed file: the way a client does it
  const uploadFile = async () => {
    const signed = await requestUpload()
    const upload = signed.body as UploadUrlBody
    mediaIds.add(upload.mediaId)
    expect((await put(upload.uploadUrl, PNG)).status).toBe(OK)
    return upload
  }

  describe('the signed URL', () => {
    it('is for a key inside the store of the request, named by the media id', async () => {
      const response = await requestUpload({ filename: '../../my photo (1).png' })
      expect(response.status).toBe(OK)
      const upload = response.body as UploadUrlBody
      expect(upload.key).toBe(
        StorageKeys.messageUpload(ctx.storeA.id, upload.mediaId, '__.._my_photo_1_.png')
      )
      expect(upload.uploadUrl).toContain(upload.key)
    })

    it('refuses a type that is not allowed', async () => {
      const response = await requestUpload({ contentType: 'text/html' })
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED)
    })

    it('refuses a file over the limit and says which', async () => {
      const response = await requestUpload({
        fileSizeBytes: UploadLimits.MAX_FILE_SIZE_BYTES + 1
      })
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_TOO_LARGE)
      expect((response.body as ErrorBody).error.metadata).toEqual({
        maxSizeBytes: UploadLimits.MAX_FILE_SIZE_BYTES
      })
    })

    it('lets a video be larger than a picture', async () => {
      const response = await requestUpload({
        contentType: 'video/mp4',
        fileSizeBytes: UploadLimits.MAX_FILE_SIZE_BYTES + 1
      })
      expect(response.status).toBe(OK)
    })

    it.each([
      ['a purpose a client may not upload for', { purpose: 'export' }],
      ['a store id in the body', { storeId: randomUUID() }],
      ['a size of zero', { fileSizeBytes: 0 }]
    ])('refuses %s', async (_name, overrides) => {
      const response = await requestUpload(overrides)
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('does not take a file of another size than the one it was signed for', async () => {
      const upload = (await requestUpload()).body as UploadUrlBody
      const bigger = Buffer.concat([PNG, Buffer.alloc(64)])
      const response = await put(upload.uploadUrl, bigger)
      // The signature covers the length: S3 answers 403 SignatureDoesNotMatch, not a transport error
      expect(response.status).toBe(FORBIDDEN)
    })

    it('needs MEDIA_UPLOAD: a viewer, who may only view, is refused', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA)
        .post(ApiRoutes.media.uploadUrl)
        .send({
          purpose: 'message',
          filename: 'a.png',
          contentType: 'image/png',
          fileSizeBytes: 10
        })
      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
    })

    it('needs a token', async () => {
      const response = await anonymousApi(app).post(ApiRoutes.media.uploadUrl).send({})
      expect(response.status).toBe(UNAUTHORIZED)
    })
  })

  describe('confirming', () => {
    it('records the media of the store, pending, and queues the scan once', async () => {
      const upload = await uploadFile()
      const before = scans().length

      const response = await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        id: upload.mediaId,
        purpose: 'message',
        filename: 'photo.png',
        contentType: 'image/png',
        fileSize: PNG.length,
        status: MediaStatus.PENDING
      } satisfies Partial<MediaBody>)
      expect(response.body).not.toHaveProperty('key')

      const row = await owner.media.findUniqueOrThrow({ where: { id: upload.mediaId } })
      expect(row).toMatchObject({
        storeId: ctx.storeA.id,
        uploadedBy: ctx.agentA.id,
        key: StorageKeys.message(ctx.storeA.id, upload.mediaId, 'photo.png'),
        status: MediaStatus.PENDING
      })
      expect(scans()).toHaveLength(before + 1)
      expect(scans().at(-1)?.data).toEqual({ mediaId: upload.mediaId })
    })

    it('keeps the file at a key the uploader has no URL for, and removes the one it uploaded to', async () => {
      const upload = await uploadFile()
      await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      const storage = app.get(StorageService, { strict: false })
      expect(await storage.head(upload.key)).toBeNull()
      expect(
        await storage.head(StorageKeys.message(ctx.storeA.id, upload.mediaId, 'photo.png'))
      ).toMatchObject({ contentLength: PNG.length, contentType: 'image/png' })
    })

    it('does not let the signed URL, still valid, change the file that was confirmed', async () => {
      const upload = await uploadFile()
      await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      const final = StorageKeys.message(ctx.storeA.id, upload.mediaId, 'photo.png')
      const storage = app.get(StorageService, { strict: false })
      const before = await storage.head(final)
      expect(before?.etag).toBeDefined()
      // Same length and type, other bytes: S3 takes it, but at the key nobody serves
      expect((await put(upload.uploadUrl, Buffer.alloc(PNG.length, 1))).status).toBe(OK)
      const after = await storage.head(final)
      expect(after?.etag).toBe(before?.etag)
      await storage.delete(upload.key)
    })

    it('queues the scan again when the first confirmation died before queueing it', async () => {
      const upload = await uploadFile()
      const queue = queueOf(app, QueueNames.HEAVY_PROCESSING)
      const spy = jest.spyOn(queue, 'add').mockRejectedValueOnce(new Error('redis went away'))
      const first = await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      spy.mockRestore()
      expect(first.status).toBe(INTERNAL_SERVER_ERROR)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(1)

      const retry = await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      expect(retry.status).toBe(OK)
      expect(
        scans().filter(job => (job.data as { mediaId: string }).mediaId === upload.mediaId)
      ).toHaveLength(1)
    })

    it('answers a repeated confirmation with the same media, and the scan under one job id', async () => {
      const upload = await uploadFile()
      const first = await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      const second = await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      expect(second.status).toBe(OK)
      expect((second.body as MediaBody).id).toBe((first.body as MediaBody).id)
      // The queue drops a job whose id it already has: both adds name the same one
      const ids = scans()
        .filter(job => (job.data as { mediaId: string }).mediaId === upload.mediaId)
        .map(job => job.opts?.jobId)
      expect(new Set(ids)).toEqual(new Set([`${JobNames.SCAN_FILE}-${upload.mediaId}`]))
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(1)
    })

    it('answers 400 and writes no row when the copy is refused because the file changed', async () => {
      const upload = await uploadFile()
      const storage = app.get(StorageService, { strict: false })
      const stored = await storage.head(upload.key)
      const copy = jest.spyOn(storage, 'copy').mockResolvedValueOnce(false)
      const response = await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
      // The copy was asked for the ETag that was checked, not for any version
      expect(copy).toHaveBeenCalledWith(
        upload.key,
        StorageKeys.message(ctx.storeA.id, upload.mediaId, 'photo.png'),
        stored?.etag
      )
      copy.mockRestore()
      expect(stored?.etag).toBeDefined()
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    })

    it('refuses a file replaced between the check and the copy, and promotes nothing', async () => {
      const upload = await uploadFile()
      const storage = app.get(StorageService, { strict: false })
      const stored = await storage.head(upload.key)
      // The uploader overwrites it after the check: the copy pinned to the checked ETag is refused
      await put(upload.uploadUrl, Buffer.alloc(PNG.length, 2))
      const final = StorageKeys.message(ctx.storeA.id, upload.mediaId, 'photo.png')
      expect(stored?.etag).toBeDefined()
      expect(await storage.copy(upload.key, final, stored?.etag)).toBe(false)
      expect(await storage.head(final)).toBeNull()
    })

    it('refuses a file that was never uploaded', async () => {
      const upload = (await requestUpload()).body as UploadUrlBody
      const response = await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    })

    it.each([
      ['a size that is not the one uploaded', { fileSizeBytes: PNG.length + 1 }],
      ['a type that is not the one uploaded', { contentType: 'image/jpeg' }]
    ])('refuses %s', async (_name, overrides) => {
      const upload = await uploadFile()
      const response = await asAgent()
        .post(ApiRoutes.media.confirmUpload)
        .send(confirmBody(upload, overrides))
      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    })

    it('refuses a type that is not allowed even when the object is there', async () => {
      const upload = await uploadFile()
      const response = await asAgent()
        .post(ApiRoutes.media.confirmUpload)
        .send(confirmBody(upload, { contentType: 'text/html' }))
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED)
    })

    it('refuses a key of another store with FILE_KEY_OUT_OF_SCOPE and writes nothing', async () => {
      const upload = await uploadFile()
      const foreignKey = StorageKeys.messageUpload(ctx.storeB.id, upload.mediaId, 'photo.png')
      const response = await asAgent()
        .post(ApiRoutes.media.confirmUpload)
        .send(confirmBody(upload, { key: foreignKey }))
      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_KEY_OUT_OF_SCOPE)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    })

    it.each([
      [
        'an export of the store',
        (storeId: string) => StorageKeys.export(storeId, randomUUID(), 'customers.csv')
      ],
      ['the store prefix itself', (storeId: string) => StorageKeys.storePrefix(storeId)],
      [
        'a traversal out of the store',
        (storeId: string) => `${StorageKeys.storePrefix(storeId)}../${randomUUID()}/x.png`
      ]
    ])('refuses %s as the key: it is not what was signed for this media', async (_name, make) => {
      const upload = await uploadFile()
      const response = await asAgent()
        .post(ApiRoutes.media.confirmUpload)
        .send(confirmBody(upload, { key: make(ctx.storeA.id) }))
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
    })

    it('refuses the media id of an upload that was signed for another id', async () => {
      const upload = await uploadFile()
      const response = await asAgent()
        .post(ApiRoutes.media.confirmUpload)
        .send(confirmBody(upload, { mediaId: randomUUID() }))
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
    })

    it('does not hand the media of another store to the member of this one', async () => {
      const upload = await uploadFile()
      await asAgent().post(ApiRoutes.media.confirmUpload).send(confirmBody(upload))
      const other = await actorWithPermissions(owner, app, {
        prefix,
        name: 'uploaderB',
        organizationId: ctx.orgB.id,
        storeId: ctx.storeB.id,
        permissions: [Permissions.MEDIA_UPLOAD]
      })
      const before = await owner.media.findUniqueOrThrow({ where: { id: upload.mediaId } })
      const response = await api(app, other, ctx.storeB)
        .post(ApiRoutes.media.confirmUpload)
        .send(confirmBody(upload))
      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.FILE_KEY_OUT_OF_SCOPE)
      expect(
        await owner.media.count({ where: { id: upload.mediaId, storeId: ctx.storeB.id } })
      ).toBe(0)
      // The media of store A, and its file, are as they were
      expect(await owner.media.findUniqueOrThrow({ where: { id: upload.mediaId } })).toEqual(before)
      expect(
        await app
          .get(StorageService, { strict: false })
          .head(StorageKeys.message(ctx.storeA.id, upload.mediaId, 'photo.png'))
      ).not.toBeNull()
    })

    it('needs MEDIA_UPLOAD', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({})
      expect(response.status).toBe(FORBIDDEN)
    })
  })
})
