import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { BulkLabelLeftOutReasons, ShipmentStatus } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { QueueNames } from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { AccountSettingsService } from '../../apps/api/src/modules/auth/account-settings.service'
import { createCarrierConnection, createShipment } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const OK = HttpStatusCodes.OK

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

// What the scan job of the worker would see at the moment it is queued: the row of the file, read from ANOTHER connection (the owner),
// so only what the request has COMMITTED is visible
class ProbeQueue extends CapturedQueue {
  readonly seen: { mediaId: string; rowVisible: boolean }[] = []

  constructor(private readonly owner: () => OwnerClient) {
    super()
  }

  override async add(
    name: string,
    data: unknown,
    opts?: { jobId?: string; delay?: number }
  ): Promise<void> {
    const { mediaId } = data as { mediaId: string }
    const rowVisible = (await this.owner().media.count({ where: { id: mediaId } })) === 1
    this.seen.push({ mediaId, rowVisible })
    await super.add(name, data, opts)
  }
}

// RLS phase 6: the confirmation of an upload is @NoTenantTransaction. The bucket (head, copy, delete of the staging copy) is called with NO
// tenant context open, so no connection is held while it answers; the row and the scan job are one unit, and the job is queued after its
// commit.
describe('RLS phase 6: confirming an upload calls the bucket with no context open', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  const opened: { call: string; tenantOpen: boolean }[] = []
  const probe = new ProbeQueue(() => owner)
  const originals: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
        .overrideProvider(getQueueToken(QueueNames.HEAVY_PROCESSING))
        .useValue(probe)
    )
    ctx = await seedTestContext(owner, app, prefix)
    const storage = app.get(StorageService, { strict: false })
    for (const method of ['head', 'copy', 'delete'] as const) {
      const original = storage[method].bind(storage) as (...args: unknown[]) => Promise<unknown>
      originals[method] = original
      jest.spyOn(storage, method).mockImplementation(((...args: unknown[]) => {
        opened.push({ call: method, tenantOpen: guarded.hasTenantContext() })
        return original(...args)
      }) as never)
    }
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    opened.length = 0
    probe.seen.length = 0
  })

  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const body = (upload: { key: string; mediaId: string }) => ({
    mediaId: upload.mediaId,
    key: upload.key,
    purpose: 'message',
    filename: 'photo.png',
    contentType: 'image/png',
    fileSizeBytes: PNG.length
  })
  // A signed upload of the store, with its bytes already put
  async function signedAndPut(): Promise<{ uploadUrl: string; key: string; mediaId: string }> {
    const signed = await asAgent().post(ApiRoutes.media.uploadUrl).send({
      purpose: 'message',
      filename: 'photo.png',
      contentType: 'image/png',
      fileSizeBytes: PNG.length
    })
    expect(signed.status).toBe(OK)
    const upload = signed.body as { uploadUrl: string; key: string; mediaId: string }
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      body: new Uint8Array(PNG)
    })
    expect(put.ok).toBe(true)
    return upload
  }
  const dropObjects = async (mediaId: string): Promise<void> => {
    const storage = app.get(StorageService, { strict: false })
    await storage
      .delete(StorageKeys.messageUpload(ctx.storeA.id, mediaId, 'photo.png'))
      .catch(() => undefined)
    await storage
      .delete(StorageKeys.message(ctx.storeA.id, mediaId, 'photo.png'))
      .catch(() => undefined)
  }

  it('checks and moves the file with no context open, and queues the scan after the row is committed', async () => {
    const asAgent = () => api(app, ctx.agentA, ctx.storeA)
    const signed = await asAgent().post(ApiRoutes.media.uploadUrl).send({
      purpose: 'message',
      filename: 'photo.png',
      contentType: 'image/png',
      fileSizeBytes: PNG.length
    })
    expect(signed.status).toBe(OK)
    const upload = signed.body as { uploadUrl: string; key: string; mediaId: string }
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      body: new Uint8Array(PNG)
    })
    expect(put.ok).toBe(true)

    const confirmed = await asAgent().post(ApiRoutes.media.confirmUpload).send({
      mediaId: upload.mediaId,
      key: upload.key,
      purpose: 'message',
      filename: 'photo.png',
      contentType: 'image/png',
      fileSizeBytes: PNG.length
    })

    expect(confirmed.status).toBe(OK)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every(call => !call.tenantOpen)).toBe(true)
    expect(probe.seen).toEqual([{ mediaId: upload.mediaId, rowVisible: true }])

    const storage = app.get(StorageService, { strict: false })
    await storage.delete(StorageKeys.message(ctx.storeA.id, upload.mediaId, 'photo.png'))
  })
  it('answers the uniform verification error for the media id of another store, and leaves no row and no scan', async () => {
    const signedB = await api(app, ctx.adminB, ctx.storeB).post(ApiRoutes.media.uploadUrl).send({
      purpose: 'message',
      filename: 'photo.png',
      contentType: 'image/png',
      fileSizeBytes: PNG.length
    })
    expect(signedB.status).toBe(OK)
    const foreign = (signedB.body as { mediaId: string }).mediaId
    const key = StorageKeys.messageUpload(ctx.storeA.id, foreign, 'photo.png')

    const response = await asAgent()
      .post(ApiRoutes.media.confirmUpload)
      .send(body({ key, mediaId: foreign }))

    expect(response.status).toBe(HttpStatusCodes.BAD_REQUEST)
    expect((response.body as { error: { code: string } }).error.code).toBe(
      ErrorCodes.FILE_UPLOAD_FAILED
    )
    expect(await owner.media.count({ where: { id: foreign } })).toBe(0)
    expect(probe.seen).toEqual([])
  })

  it('leaves no row and no scan when the bucket refuses the copy after the checks', async () => {
    const upload = await signedAndPut()
    const storage = app.get(StorageService, { strict: false })
    jest.spyOn(storage, 'copy').mockResolvedValueOnce(false)

    const response = await asAgent().post(ApiRoutes.media.confirmUpload).send(body(upload))

    expect(response.status).toBe(HttpStatusCodes.BAD_REQUEST)
    expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(0)
    expect(probe.seen).toEqual([])
    await dropObjects(upload.mediaId)
  })

  it('does not hold the unit while the bucket is slow: a head that takes longer than the 15 s of a transaction still confirms', async () => {
    const upload = await signedAndPut()
    const storage = app.get(StorageService, { strict: false })
    jest.spyOn(storage, 'head').mockImplementationOnce(async (...args) => {
      opened.push({ call: 'head', tenantOpen: guarded.hasTenantContext() })
      await new Promise(resolve => setTimeout(resolve, 16_000))
      return (await originals['head']?.(...args)) as never
    })

    const response = await asAgent().post(ApiRoutes.media.confirmUpload).send(body(upload))

    expect(response.status).toBe(OK)
    expect(opened[0]).toEqual({ call: 'head', tenantOpen: false })
    expect(await owner.media.count({ where: { id: upload.mediaId } })).toBe(1)
    await dropObjects(upload.mediaId)
  }, 60_000)

  it('merges no label of a guide of another store: it is left out as not found and the other store is untouched', async () => {
    const connection = await createCarrierConnection(owner, {
      storeId: ctx.storeB.id,
      prefix: 'MB'
    })
    const foreign = await createShipment(owner, {
      storeId: ctx.storeB.id,
      connectionId: connection.id,
      guideNumber: `${prefix}-G1`,
      status: ShipmentStatus.LABEL_CREATED
    })

    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.shipments.mergeLabels)
      .send({ shipmentIds: [foreign.id] })

    expect(response.status).toBe(OK)
    const merged = response.body as {
      download: unknown
      merged: string[]
      leftOut: { shipmentId: string; reason: string }[]
    }
    expect(merged.download).toBeNull()
    expect(merged.merged).toEqual([])
    expect(merged.leftOut).toEqual([
      { shipmentId: foreign.id, reason: BulkLabelLeftOutReasons.NOT_FOUND }
    ])
    expect(await owner.shipment.count({ where: { id: foreign.id, storeId: ctx.storeB.id } })).toBe(
      1
    )
  })

  it('rolls the profile change back as one unit: the old picture is not removed and no entry is left', async () => {
    const before = await owner.user.findUniqueOrThrow({
      where: { id: ctx.adminA.id },
      select: { name: true }
    })
    jest
      .spyOn(app.get(AccountSettingsService), 'swapProfile' as never)
      .mockRejectedValueOnce(new Error('the swap failed') as never)

    const response = await api(app, ctx.adminA, ctx.storeA)
      .patch(ApiRoutes.account.profile)
      .send({ name: 'Another Name' })

    expect(response.status).toBe(HttpStatusCodes.INTERNAL_SERVER_ERROR)
    expect(opened.some(call => call.call === 'delete')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.ACCOUNT_PROFILE_UPDATED, resourceId: ctx.adminA.id }
      })
    ).toBe(0)
    const after = await owner.user.findUniqueOrThrow({
      where: { id: ctx.adminA.id },
      select: { name: true }
    })
    expect(after.name).toBe(before.name)
  })
})
