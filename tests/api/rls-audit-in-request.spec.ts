import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const CREATED = 201
const ROUNDS = 12

// RLS phase 6: with the switch ON a request is ONE transaction that the interceptor commits as soon as the handler answers. The audit
// entry of a request is written by `AuditService.log()` without being awaited, so it used to reach the connection after the commit
// ("Transaction already closed") and the entry was lost. The commit now waits for the entries the request wrote. This reads the table
// right after each answer, with NO waiting loop: an entry that is only there "soon" is the bug.
describe('RLS phase 6: the audit entry of a request survives the commit of the request', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext

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
    )
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const make = (name: string) =>
    api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.settings.apiKeys)
      .send({ name, scopes: [Permissions.CUSTOMERS_VIEW] })

  it('writes the entry of every request before its answer, in the store and for the person who asked', async () => {
    const ids: string[] = []
    for (let round = 0; round < ROUNDS; round += 1) {
      const response = await make(`${prefix}-key-${round}`)
      expect(response.status).toBe(CREATED)
      ids.push((response.body as { id: string }).id)
    }

    const rows = await owner.auditLog.findMany({
      where: { action: AuditAction.API_KEY_CREATED, resourceId: { in: ids } }
    })

    expect(rows).toHaveLength(ROUNDS)
    expect(new Set(rows.map(row => row.resourceId))).toEqual(new Set(ids))
    for (const row of rows) {
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(row.userId).toBe(ctx.adminA.id)
    }
  })

  it('does not write the entry of one store in another, and writes it once', async () => {
    const response = await make(`${prefix}-key-once`)
    const id = (response.body as { id: string }).id

    const rows = await owner.auditLog.findMany({
      where: { action: AuditAction.API_KEY_CREATED, resourceId: id }
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.storeId).toBe(ctx.storeA.id)
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.API_KEY_CREATED, storeId: ctx.storeB.id, resourceId: id }
      })
    ).toBe(0)
  })
})
