import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { HttpStatusCodes } from '@platform/core/errors'
import { QueueNames } from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

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
})
