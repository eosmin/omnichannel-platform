import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import { JobNames, QueueNames } from '@platform/core/queues'
import { ProductImageUpload, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

interface UploadUrlBody {
  uploadUrl: string
  key: string
  mediaId: string
}
interface ErrorBody {
  error: { code: string }
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

// The purpose `product` of the upload routes: who may attach a picture and to what (TDD_07 §6.3)
describe('Media upload for a product', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let editor: Actor
  let uploaderOnly: Actor
  let productA: string
  let productB: string
  const mediaIds = new Set<string>()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const base = { prefix, organizationId: ctx.orgA.id, storeId: ctx.storeA.id }
    editor = await actorWithPermissions(owner, app, {
      ...base,
      name: 'productEditorA',
      permissions: [Permissions.MEDIA_UPLOAD, Permissions.PRODUCTS_EDIT]
    })
    uploaderOnly = await actorWithPermissions(owner, app, {
      ...base,
      name: 'uploaderOnlyA',
      permissions: [Permissions.MEDIA_UPLOAD]
    })
    const make = (storeId: string, name: string) =>
      owner.product.create({
        data: { storeId, name: `${prefix}-${name}`, priceCents: 1000 },
        select: { id: true }
      })
    productA = (await make(ctx.storeA.id, 'productA')).id
    productB = (await make(ctx.storeB.id, 'productB')).id
  })
  afterAll(async () => {
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

  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const body = (overrides: Record<string, unknown> = {}) => ({
    purpose: 'product',
    parentId: productA,
    filename: 'photo.png',
    contentType: 'image/png',
    fileSizeBytes: PNG.length,
    ...overrides
  })
  const requestUrl = (actor: Actor, overrides: Record<string, unknown> = {}) =>
    api(app, actor, ctx.storeA).post(ApiRoutes.media.uploadUrl).send(body(overrides))
  const confirm = (actor: Actor, upload: UploadUrlBody, overrides: Record<string, unknown> = {}) =>
    api(app, actor, ctx.storeA)
      .post(ApiRoutes.media.confirmUpload)
      .send({ ...body(), mediaId: upload.mediaId, key: upload.key, ...overrides })
  const putFile = async (upload: UploadUrlBody) =>
    fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      body: new Uint8Array(PNG)
    })
  const signed = async (): Promise<UploadUrlBody> => {
    const response = await requestUrl(editor)
    expect(response.status).toBe(OK)
    const upload = response.body as UploadUrlBody
    mediaIds.add(upload.mediaId)
    expect((await putFile(upload)).status).toBe(OK)
    return upload
  }

  describe('the signed URL', () => {
    it('is given to who may upload and edit products, for a product of the store', async () => {
      const response = await requestUrl(editor)
      expect(response.status).toBe(OK)
      const upload = response.body as UploadUrlBody
      mediaIds.add(upload.mediaId)
      expect(upload.key).toBe(StorageKeys.messageUpload(ctx.storeA.id, upload.mediaId, 'photo.png'))
    })

    it('is refused with PERMISSION_DENIED to who may upload but not edit products', async () => {
      const response = await requestUrl(uploaderOnly)
      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      // The same member still uploads what its permission covers
      const message = await requestUrl(uploaderOnly, { purpose: 'message', parentId: undefined })
      expect(message.status).toBe(OK)
      mediaIds.add((message.body as UploadUrlBody).mediaId)
    })

    it('answers the same 404 for a product of another store and for one that does not exist', async () => {
      const foreign = await requestUrl(editor, { parentId: productB })
      const missing = await requestUrl(editor, { parentId: randomUUID() })
      expect(foreign.status).toBe(NOT_FOUND)
      expect(missing.status).toBe(NOT_FOUND)
      expect((foreign.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
    })

    it('asks for the permission before it looks at the product: no probing of ids by who lacks it', async () => {
      const foreign = await requestUrl(uploaderOnly, { parentId: productB })
      const missing = await requestUrl(uploaderOnly, { parentId: randomUUID() })
      expect(foreign.status).toBe(FORBIDDEN)
      expect(missing.status).toBe(FORBIDDEN)
    })

    it('refuses what a product picture may not be: a gif, a document, a file over the limit', async () => {
      for (const contentType of ['image/gif', 'application/pdf', 'video/mp4']) {
        const response = await requestUrl(editor, { contentType })
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED)
      }
      const large = await requestUrl(editor, {
        fileSizeBytes: ProductImageUpload.MAX_SIZE_BYTES + 1
      })
      expect(large.status).toBe(BAD_REQUEST)
      expect(codeOf(large.body)).toBe(ErrorCodes.FILE_TOO_LARGE)
    })

    it('needs the parentId for a product and refuses it for a message file', async () => {
      const missing = await requestUrl(editor, { parentId: undefined })
      expect(missing.status).toBe(BAD_REQUEST)
      expect(codeOf(missing.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      const message = await requestUrl(editor, { purpose: 'message' })
      expect(message.status).toBe(BAD_REQUEST)
      expect(codeOf(message.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })
  })

  describe('the confirmation', () => {
    it('keeps the file as a picture of the product, in the store of the request', async () => {
      const upload = await signed()
      const response = await confirm(editor, upload)
      expect(response.status).toBe(OK)
      const row = await owner.media.findUniqueOrThrow({
        where: { id: upload.mediaId },
        select: { storeId: true, productId: true, purpose: true, messageId: true, status: true }
      })
      expect(row).toEqual({
        storeId: ctx.storeA.id,
        productId: productA,
        purpose: 'product',
        messageId: null,
        status: 'pending'
      })
      const scans = queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.filter(
        job =>
          job.name === JobNames.SCAN_FILE &&
          (job.data as { mediaId: string }).mediaId === upload.mediaId
      )
      expect(scans).toHaveLength(1)
    })

    it('is refused to who may not edit products, and writes no row', async () => {
      const upload = await signed()
      const response = await confirm(uploaderOnly, upload)
      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    })

    it('does not attach to a product of another store, and writes no row', async () => {
      const upload = await signed()
      const response = await confirm(editor, upload, { parentId: productB })
      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
      expect(await owner.media.count({ where: { productId: productB } })).toBe(0)
    })

    it('answers a retry with the same parent with the same media: one row, one scan', async () => {
      const upload = await signed()
      const first = await confirm(editor, upload)
      const again = await confirm(editor, upload)
      expect(first.status).toBe(OK)
      expect(again.status).toBe(OK)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(1)
      const scans = queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.filter(
        job =>
          job.name === JobNames.SCAN_FILE &&
          (job.data as { mediaId: string }).mediaId === upload.mediaId
      )
      expect(scans.length).toBeGreaterThanOrEqual(1)
      expect(new Set(scans.map(job => job.opts?.jobId)).size).toBe(1)
    })

    it('does not take a confirmation under another purpose than the one that was kept', async () => {
      const upload = await signed()
      expect((await confirm(editor, upload)).status).toBe(OK)
      const other = await api(app, editor, ctx.storeA).post(ApiRoutes.media.confirmUpload).send({
        purpose: 'message',
        mediaId: upload.mediaId,
        key: upload.key,
        filename: 'photo.png',
        contentType: 'image/png',
        fileSizeBytes: PNG.length
      })
      expect(other.status).toBe(BAD_REQUEST)
      expect(codeOf(other.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
    })

    it('does not move a confirmed picture to another product by confirming again', async () => {
      const second = (
        await owner.product.create({
          data: { storeId: ctx.storeA.id, name: `${prefix}-second`, priceCents: 1 },
          select: { id: true }
        })
      ).id
      const upload = await signed()
      expect((await confirm(editor, upload)).status).toBe(OK)
      const again = await confirm(editor, upload, { parentId: second })
      expect(again.status).toBe(BAD_REQUEST)
      expect(codeOf(again.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
      expect(
        (await owner.media.findUniqueOrThrow({ where: { id: upload.mediaId } })).productId
      ).toBe(productA)
    })
  })
})
