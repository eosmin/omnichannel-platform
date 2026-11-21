import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import {
  ExportFormats,
  ExportStatus,
  ExportTypes,
  JobNames,
  QueueNames
} from '@platform/core/queues'

import { ExportsService } from '../../apps/api/src/modules/exports'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const ACCEPTED = 202
const SERVER_ERROR = 500

// What the worker would see at the moment a job is added: the row of the export, read from ANOTHER connection (the owner), so only what
// the request has COMMITTED is visible. A queue that is down is told to fail.
class ProbeQueue extends CapturedQueue {
  readonly seen: { name: string; exportId: string; rowVisible: boolean }[] = []
  failNext = false

  constructor(private readonly owner: () => OwnerClient) {
    super()
  }

  override async add(
    name: string,
    data: unknown,
    opts?: { jobId?: string; delay?: number }
  ): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('the queue is down')
    }
    const { exportId } = data as { exportId: string }
    const rowVisible = (await this.owner().export.count({ where: { id: exportId } })) === 1
    this.seen.push({ name, exportId, rowVisible })
    await super.add(name, data, opts)
  }
}

// RLS phase 6, N-1: with RLS_CONTEXT on the request is ONE transaction that the interceptor commits when the handler returns, and
// `prisma.transaction()` inside it only joins it. A job queued on the line that follows it used to start before the COMMIT: the worker
// found no row and ended without a retry. The job is now queued by PrismaService.afterCommitStep: after the real commit, never when the
// request rolls back, and a queue that is down still fails the request (after the commit, as always).
describe('RLS phase 6: a job is queued after the real commit of the request', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
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
        .overrideProvider(getQueueToken(QueueNames.EXPORTS))
        .useValue(probe)
    )
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    probe.jobs.length = 0
    probe.seen.length = 0
    probe.failNext = false
  })

  it('queues the job of an export only when the row can be read from another connection, and once', async () => {
    const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.customers.export)

    expect(response.status).toBe(ACCEPTED)
    const { id } = response.body as { id: string }
    expect(probe.seen).toEqual([{ name: JobNames.GENERATE_EXPORT, exportId: id, rowVisible: true }])
  })

  it('queues nothing when the request rolls back, and leaves no row', async () => {
    const exports = app.get(ExportsService)
    const mine = { storeId: ctx.storeA.id, requestedBy: ctx.adminA.id }
    const before = await owner.export.count({ where: mine })

    await expect(
      guarded.tenantTransaction(
        { storeIds: [ctx.storeA.id], organizationIds: [ctx.orgA.id] },
        async () => {
          await exports.request({
            storeId: ctx.storeA.id,
            userId: ctx.adminA.id,
            type: ExportTypes.CUSTOMERS,
            format: ExportFormats.CSV,
            filters: {}
          })
          // The handler is still running: nothing may be on the queue yet
          expect(probe.seen).toEqual([])
          throw new Error('the request failed after the export was requested')
        }
      )
    ).rejects.toThrow('the request failed')

    expect(probe.seen).toEqual([])
    expect(await owner.export.count({ where: mine })).toBe(before)
  })

  it('fails the request when the queue is down, after closing the export as failed', async () => {
    probe.failNext = true

    const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.customers.export)

    expect(response.status).toBe(SERVER_ERROR)
    expect(probe.seen).toEqual([])
    const rows = await owner.export.findMany({
      where: { storeId: ctx.storeA.id, requestedBy: ctx.adminA.id, status: ExportStatus.FAILED }
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.error).toBe(ErrorCodes.EXPORT_FAILED)
  })
})
