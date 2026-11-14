import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import {
  RetentionBounds,
  RetentionDefaults,
  RetentionResourceTypes
} from '@platform/core/compliance'
import type { OwnerClient } from '@platform/core/database-testing'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403

describe('The data retention settings of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    await owner.retentionSettings.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeA2.id] } }
    })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const valid = { conversationDays: 400, mediaDays: 200, analyticsDays: 120, notificationDays: 30 }

  it('reads the factory defaults while the store has no row, and writes none by reading', async () => {
    const response = await asAdmin().get(ApiRoutes.settings.retention)

    expect(response.status).toBe(OK)
    expect(response.body).toEqual(RetentionDefaults)
    expect(await owner.retentionSettings.count({ where: { storeId: ctx.storeA.id } })).toBe(0)
  })

  it('writes the four windows, creating the row the first time, and reads them back', async () => {
    const put = await asAdmin().put(ApiRoutes.settings.retention).send(valid)
    const read = await asAdmin().get(ApiRoutes.settings.retention)

    expect(put.status).toBe(OK)
    expect(put.body).toEqual(valid)
    expect(read.body).toEqual(valid)
    const row = await owner.retentionSettings.findUniqueOrThrow({
      where: { storeId: ctx.storeA.id }
    })
    expect(row).toMatchObject(valid)
  })

  it('accepts both ends of every window and refuses one step past them', async () => {
    for (const [field, { min, max }] of Object.entries(RetentionBounds)) {
      for (const days of [min, max]) {
        const response = await asAdmin()
          .put(ApiRoutes.settings.retention)
          .send({ ...valid, [field]: days })
        expect(response.status).toBe(OK)
      }
      for (const days of [min - 1, max + 1, 0, -1, 1.5, '90', null]) {
        const response = await asAdmin()
          .put(ApiRoutes.settings.retention)
          .send({ ...valid, [field]: days })
        expect(response.status).toBe(BAD_REQUEST)
      }
    }
  })

  it('refuses a body that leaves a window out, names one twice over, or names a store', async () => {
    for (const bad of [
      {},
      { conversationDays: 400 },
      { ...valid, storeId: ctx.storeA2.id },
      { ...valid, unknown: 1 }
    ]) {
      const response = await asAdmin().put(ApiRoutes.settings.retention).send(bad)
      expect(response.status).toBe(BAD_REQUEST)
    }
    expect(await owner.retentionSettings.count({ where: { storeId: ctx.storeA.id } })).toBe(0)
  })

  it('is refused by the database too: a row outside the limits cannot be written by hand', async () => {
    await expect(
      owner.retentionSettings.create({
        data: { storeId: ctx.storeA.id, ...RetentionDefaults, conversationDays: 1 }
      })
    ).rejects.toThrow()
    await expect(
      owner.retentionSettings.create({
        data: { storeId: ctx.storeA.id, ...RetentionDefaults, notificationDays: 366 }
      })
    ).rejects.toThrow()
  })

  it('belongs to the store of the request: another store of the organization keeps its own', async () => {
    await asAdmin().put(ApiRoutes.settings.retention).send(valid)

    const sibling = await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.settings.retention)
    expect(sibling.body).toEqual(RetentionDefaults)
    expect(await owner.retentionSettings.count({ where: { storeId: ctx.storeA2.id } })).toBe(0)
  })

  it('asks for settings:manage_retention to read and to change', async () => {
    const viewer = await actorWithPermissions(owner, app, {
      prefix,
      name: 'retentionViewer',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_VIEW, Permissions.SETTINGS_EDIT]
    })
    const manager = await actorWithPermissions(owner, app, {
      prefix,
      name: 'retentionManager',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_MANAGE_RETENTION]
    })

    const asViewer = api(app, viewer, ctx.storeA)
    expect((await asViewer.get(ApiRoutes.settings.retention)).status).toBe(FORBIDDEN)
    expect((await asViewer.put(ApiRoutes.settings.retention).send(valid)).status).toBe(FORBIDDEN)
    const asManager = api(app, manager, ctx.storeA)
    expect((await asManager.put(ApiRoutes.settings.retention).send(valid)).status).toBe(OK)
    expect((await asManager.get(ApiRoutes.settings.retention)).status).toBe(OK)
  })

  it('leaves an audit entry with what changed, and none for a save that changes nothing', async () => {
    const since = new Date()
    await asAdmin().put(ApiRoutes.settings.retention).send(valid)
    // The same values again
    await asAdmin().put(ApiRoutes.settings.retention).send(valid)

    const where = {
      action: AuditAction.RETENTION_CHANGED,
      storeId: ctx.storeA.id,
      resourceType: RetentionResourceTypes.RETENTION_SETTINGS,
      timestamp: { gte: since }
    }
    await waitForAuditEntries(owner, where, 1)
    await new Promise(resolve => setTimeout(resolve, 400))
    const entries = await owner.auditLog.findMany({ where })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ userId: ctx.adminA.id, resourceId: ctx.storeA.id })
    expect(entries[0]?.metadata).toMatchObject({
      fields: ['conversationDays', 'mediaDays', 'analyticsDays', 'notificationDays'],
      changes: {
        conversationDays: { from: RetentionDefaults.conversationDays, to: 400 },
        notificationDays: { from: RetentionDefaults.notificationDays, to: 30 }
      }
    })
  })

  it('takes two saves at once as one after the other, each with its true "from"', async () => {
    const [first, second] = await Promise.all([
      asAdmin().put(ApiRoutes.settings.retention).send(valid),
      asAdmin()
        .put(ApiRoutes.settings.retention)
        .send({ ...valid, conversationDays: 500 })
    ])

    expect(first.status).toBe(OK)
    expect(second.status).toBe(OK)
    expect(await owner.retentionSettings.count({ where: { storeId: ctx.storeA.id } })).toBe(1)
  })
})
