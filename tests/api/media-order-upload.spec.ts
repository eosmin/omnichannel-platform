import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { PaymentMethod } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { JobNames, QueueNames } from '@platform/core/queues'
import { OrderFileUpload, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { createCustomer } from '../builders'
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

// The purpose `order` of the upload routes: who may attach a proof or a receipt and to what (TDD_07 §6.3)
describe('Media upload for an order', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let editor: Actor
  let statusChanger: Actor
  let uploaderOnly: Actor
  let blindEditor: Actor
  let mediaViewerOnly: Actor
  let orderReader: Actor
  let orderA: string
  let orderB: string
  const mediaIds = new Set<string>()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const base = { prefix, organizationId: ctx.orgA.id, storeId: ctx.storeA.id }
    editor = await actorWithPermissions(owner, app, {
      ...base,
      name: 'orderEditorA',
      permissions: [Permissions.MEDIA_UPLOAD, Permissions.ORDERS_VIEW, Permissions.ORDERS_EDIT]
    })
    statusChanger = await actorWithPermissions(owner, app, {
      ...base,
      name: 'orderStatusA',
      permissions: [
        Permissions.MEDIA_UPLOAD,
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CHANGE_STATUS
      ]
    })
    uploaderOnly = await actorWithPermissions(owner, app, {
      ...base,
      name: 'uploaderOnlyOrderA',
      permissions: [Permissions.MEDIA_UPLOAD, Permissions.ORDERS_VIEW]
    })
    blindEditor = await actorWithPermissions(owner, app, {
      ...base,
      name: 'blindEditorA',
      permissions: [Permissions.MEDIA_UPLOAD, Permissions.ORDERS_EDIT]
    })
    mediaViewerOnly = await actorWithPermissions(owner, app, {
      ...base,
      name: 'mediaViewerOnlyA',
      permissions: [Permissions.MEDIA_VIEW]
    })
    orderReader = await actorWithPermissions(owner, app, {
      ...base,
      name: 'orderReaderA',
      permissions: [Permissions.MEDIA_VIEW, Permissions.ORDERS_VIEW]
    })
    const make = async (storeId: string) => {
      const customer = await createCustomer(owner, { storeId })
      return (
        await owner.order.create({
          data: {
            storeId,
            customerId: customer.id,
            orderNumber: `${prefix}-${randomUUID().slice(0, 6)}`,
            subtotalCents: 1000,
            totalCents: 1000,
            paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
            createdBy: ctx.adminA.id
          },
          select: { id: true }
        })
      ).id
    }
    orderA = await make(ctx.storeA.id)
    orderB = await make(ctx.storeB.id)
  })
  afterAll(async () => {
    const storage = app.get(StorageService, { strict: false })
    await Promise.all(
      [...mediaIds].flatMap(id => [
        storage.delete(StorageKeys.messageUpload(ctx.storeA.id, id, 'receipt.png')),
        storage.delete(StorageKeys.message(ctx.storeA.id, id, 'receipt.png'))
      ])
    )
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const body = (overrides: Record<string, unknown> = {}) => ({
    purpose: 'order',
    parentId: orderA,
    filename: 'receipt.png',
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
    it('is given to who edits orders, and to who changes their status, for an order of the store', async () => {
      for (const actor of [editor, statusChanger]) {
        const response = await requestUrl(actor)
        expect(response.status).toBe(OK)
        mediaIds.add((response.body as UploadUrlBody).mediaId)
      }
    })

    it('is refused with PERMISSION_DENIED to who may upload but neither edit nor change the status', async () => {
      const response = await requestUrl(uploaderOnly)
      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
    })

    it('answers the same 404 for an order of another store and for one that does not exist', async () => {
      const foreign = await requestUrl(editor, { parentId: orderB })
      const missing = await requestUrl(editor, { parentId: randomUUID() })
      expect(foreign.status).toBe(NOT_FOUND)
      expect(missing.status).toBe(NOT_FOUND)
      expect((foreign.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
    })

    it('asks for the permission before it looks at the order: no probing of ids by who lacks it', async () => {
      const foreign = await requestUrl(uploaderOnly, { parentId: orderB })
      const missing = await requestUrl(uploaderOnly, { parentId: randomUUID() })
      expect(foreign.status).toBe(FORBIDDEN)
      expect(missing.status).toBe(FORBIDDEN)
    })

    it('is refused to who edits orders but may not view them, whatever the id: it tells nothing about orders', async () => {
      const own = await requestUrl(blindEditor)
      const foreign = await requestUrl(blindEditor, { parentId: orderB })
      const missing = await requestUrl(blindEditor, { parentId: randomUUID() })
      for (const response of [own, foreign, missing]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      }
    })

    it('takes a PDF and refuses a gif, a video and a file over the limit', async () => {
      const pdf = await requestUrl(editor, {
        filename: 'receipt.pdf',
        contentType: 'application/pdf'
      })
      expect(pdf.status).toBe(OK)
      mediaIds.add((pdf.body as UploadUrlBody).mediaId)
      for (const contentType of ['image/gif', 'video/mp4', 'text/plain']) {
        const response = await requestUrl(editor, { contentType })
        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.FILE_TYPE_NOT_ALLOWED)
      }
      const large = await requestUrl(editor, { fileSizeBytes: OrderFileUpload.MAX_SIZE_BYTES + 1 })
      expect(large.status).toBe(BAD_REQUEST)
      expect(codeOf(large.body)).toBe(ErrorCodes.FILE_TOO_LARGE)
    })

    it('needs the parentId for an order', async () => {
      const missing = await requestUrl(editor, { parentId: undefined })
      expect(missing.status).toBe(BAD_REQUEST)
      expect(codeOf(missing.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })
  })

  describe('the confirmation', () => {
    it('keeps the file as a file of the order, in the store of the request', async () => {
      const upload = await signed()
      const response = await confirm(editor, upload)
      expect(response.status).toBe(OK)
      const row = await owner.media.findUniqueOrThrow({
        where: { id: upload.mediaId },
        select: {
          storeId: true,
          orderId: true,
          productId: true,
          purpose: true,
          messageId: true,
          status: true
        }
      })
      expect(row).toEqual({
        storeId: ctx.storeA.id,
        orderId: orderA,
        productId: null,
        purpose: 'order',
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

    it('is refused to who may not edit the order, and writes no row', async () => {
      const upload = await signed()
      const response = await confirm(uploaderOnly, upload)
      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    })

    it('does not attach to an order of another store, and writes no row', async () => {
      const upload = await signed()
      const response = await confirm(editor, upload, { parentId: orderB })
      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
      expect(await owner.media.count({ where: { orderId: orderB } })).toBe(0)
    })

    it('does not attach to an order that does not exist', async () => {
      const upload = await signed()
      const response = await confirm(editor, upload, { parentId: randomUUID() })
      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    })

    it('answers a retry with the same parent with the same media: one row', async () => {
      const upload = await signed()
      const first = await confirm(editor, upload)
      const again = await confirm(editor, upload)
      expect(first.status).toBe(OK)
      expect(again.status).toBe(OK)
      expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(1)
    })

    it('does not move a confirmed file to another order by confirming again', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const second = (
        await owner.order.create({
          data: {
            storeId: ctx.storeA.id,
            customerId: customer.id,
            orderNumber: `${prefix}-${randomUUID().slice(0, 6)}`,
            subtotalCents: 1,
            totalCents: 1,
            paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
            createdBy: ctx.adminA.id
          },
          select: { id: true }
        })
      ).id
      const upload = await signed()
      expect((await confirm(editor, upload)).status).toBe(OK)
      const again = await confirm(editor, upload, { parentId: second })
      expect(again.status).toBe(BAD_REQUEST)
      expect(codeOf(again.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
      expect((await owner.media.findUniqueOrThrow({ where: { id: upload.mediaId } })).orderId).toBe(
        orderA
      )
    })

    it('does not take a confirmation under another purpose than the one that was kept', async () => {
      const upload = await signed()
      expect((await confirm(editor, upload)).status).toBe(OK)
      const other = await api(app, editor, ctx.storeA).post(ApiRoutes.media.confirmUpload).send({
        purpose: 'message',
        mediaId: upload.mediaId,
        key: upload.key,
        filename: 'receipt.png',
        contentType: 'image/png',
        fileSizeBytes: PNG.length
      })
      expect(other.status).toBe(BAD_REQUEST)
      expect(codeOf(other.body)).toBe(ErrorCodes.FILE_UPLOAD_FAILED)
    })
  })

  describe('the signed link of a file of an order', () => {
    async function cleanFile(storeId: string, orderId: string): Promise<string> {
      const id = randomUUID()
      await owner.media.create({
        data: {
          id,
          storeId,
          purpose: 'order',
          orderId,
          key: `${prefix}/order-file/${id}`,
          filename: 'receipt.png',
          contentType: 'image/png',
          fileSize: PNG.length,
          status: 'clean'
        }
      })
      return id
    }

    it('is given to who may view orders and refused to who may only view media', async () => {
      const id = await cleanFile(ctx.storeA.id, orderA)
      const denied = await api(app, mediaViewerOnly, ctx.storeA).get(ApiRoutes.media.byId(id))
      const allowed = await api(app, orderReader, ctx.storeA).get(ApiRoutes.media.byId(id))
      expect(denied.status).toBe(FORBIDDEN)
      expect(codeOf(denied.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(allowed.status).toBe(OK)
    })

    it('is not given through another store', async () => {
      const id = await cleanFile(ctx.storeA.id, orderA)
      const response = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.media.byId(id))
      expect(response.status).toBe(NOT_FOUND)
    })
  })
})
