import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { AppPaths, CarrierId, MembershipStatus, StoreSettingsSections } from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'
import { QueueNames } from '@platform/core/queues'

import { createCarrierConnection } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue } from '../helpers/queue'

// The first sighting of a code nobody mapped (TDD_17 §4.17, Step 4.8 PR C2c): the worker raises `carrier.status_unmapped` and the
// api turns it into a notification for the members who manage carriers
describe('The carrier.status_unmapped notification', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const pushQueue = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS)).useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.notification.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } }
    })
  })

  const emit = (payload: object) =>
    app.get(EventEmitter2).emitAsync(Events.CARRIER_STATUS_UNMAPPED, payload)
  const rowsOf = (storeId = ctx.storeA.id) =>
    owner.notification.findMany({
      where: { storeId, type: NotificationTypes.CARRIER_STATUS_UNMAPPED }
    })
  async function member(
    name: string,
    permissions: Parameters<typeof actorWithPermissions>[2]['permissions']
  ) {
    return actorWithPermissions(owner, app, {
      prefix,
      name: `${name}${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions
    })
  }
  const connectionOf = (storeId: string, displayName = `Courier ${randomUUID().slice(0, 8)}`) =>
    createCarrierConnection(owner, {
      storeId,
      carrierId: CarrierId.LOCAL,
      displayName,
      prefix: `U${randomUUID().slice(0, 4)}`.toUpperCase()
    })

  it('tells the members who manage carriers, and nobody else', async () => {
    const holder = await member('carrierHolder', [Permissions.SETTINGS_MANAGE_CARRIERS])
    const without = await member('carrierWithout', [Permissions.SHIPPING_VIEW])
    const connection = await connectionOf(ctx.storeA.id, 'Courier One')

    await emit({ storeId: ctx.storeA.id, connectionId: connection.id, providerCode: '16:115' })

    const rows = await rowsOf()
    const told = rows.map(row => row.userId)
    expect(told).toContain(holder.id)
    expect(told).not.toContain(without.id)
    expect(told).not.toContain(ctx.adminB.id)
    expect(rows.find(row => row.userId === holder.id)).toMatchObject({
      resourceType: 'carrier_connection',
      resourceId: connection.id,
      actionPath: AppPaths.store.settings(ctx.storeA.id, StoreSettingsSections.CARRIERS),
      params: { carrier: 'Courier One', code: '16:115' }
    })
    expect(await rowsOf(ctx.storeB.id)).toHaveLength(0)
  })

  it('does not tell a member whose access was revoked or suspended', async () => {
    const revoked = await member('carrierRevoked', [Permissions.SETTINGS_MANAGE_CARRIERS])
    const suspended = await member('carrierSuspended', [Permissions.SETTINGS_MANAGE_CARRIERS])
    await owner.membership.updateMany({
      where: { userId: revoked.id, storeId: ctx.storeA.id },
      data: { revokedAt: new Date() }
    })
    await owner.membership.updateMany({
      where: { userId: suspended.id, storeId: ctx.storeA.id },
      data: { status: MembershipStatus.SUSPENDED }
    })
    const connection = await connectionOf(ctx.storeA.id)

    await emit({ storeId: ctx.storeA.id, connectionId: connection.id, providerCode: 'x1' })

    const told = (await rowsOf()).map(row => row.userId)
    expect(told).not.toContain(revoked.id)
    expect(told).not.toContain(suspended.id)
  })

  it('tells nobody about a connection that is not in the store of the event', async () => {
    await member('carrierOtherStore', [Permissions.SETTINGS_MANAGE_CARRIERS])
    const stranger = await connectionOf(ctx.storeB.id)

    await emit({ storeId: ctx.storeA.id, connectionId: stranger.id, providerCode: 'x1' })
    await emit({ storeId: ctx.storeA.id, connectionId: randomUUID(), providerCode: 'x1' })

    expect(await rowsOf()).toHaveLength(0)
    expect(await rowsOf(ctx.storeB.id)).toHaveLength(0)
  })
})
