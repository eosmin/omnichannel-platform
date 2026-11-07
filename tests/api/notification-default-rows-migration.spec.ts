import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { INestApplication } from '@nestjs/common'

import type { OwnerClient } from '@platform/core/database-testing'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationPreferencesService } from '../../apps/api/src/modules/notifications/notification-preferences.service'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const MIGRATION = join(
  __dirname,
  '../../libs/core/database/prisma/migrations/20261114120000_push_default_rows/migration.sql'
)

// Runs the unscoped DELETE of the migration on the test database, so it relies on the suites running one
// at a time (`--runInBand`, as the security-tests job and `nx run tests:test-security` do).
// The data migration that removes the rows holding exactly the old default of the two types that push by
// default now (owner, 2026-11-08). It is run here against the test database over rows made for the case.
describe('Migration push_default_rows', () => {
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
  afterEach(async () => {
    await owner.notificationPreference.deleteMany({ where: { storeId: ctx.storeA.id } })
  })

  const row = (
    userId: string,
    type: string,
    [inApp, push, email, sound]: [boolean, boolean, boolean, boolean]
  ) =>
    owner.notificationPreference.create({
      data: { userId, storeId: ctx.storeA.id, type, inApp, push, email, sound }
    })
  const migrate = () => owner.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'))
  const has = async (userId: string, type: string) =>
    (await owner.notificationPreference.count({
      where: { userId, storeId: ctx.storeA.id, type }
    })) === 1

  it('removes a row that holds exactly the old default of its type, and only those', async () => {
    const { MESSAGE_RECEIVED, CONVERSATION_UNASSIGNED_QUEUE } = NotificationTypes
    const [admin, agent, viewer] = [ctx.adminA.id, ctx.agentA.id, ctx.viewerA.id]
    await row(admin, MESSAGE_RECEIVED, [true, false, false, true]) // old default: removed
    await row(viewer, CONVERSATION_UNASSIGNED_QUEUE, [true, false, false, false]) // old default: removed
    await row(agent, MESSAGE_RECEIVED, [true, false, true, true]) // an email chosen: kept
    await row(admin, CONVERSATION_UNASSIGNED_QUEUE, [true, false, true, false]) // an email chosen: kept
    await row(viewer, MESSAGE_RECEIVED, [true, true, false, true]) // push already on: kept
    // Another type with the same four values is not touched
    await row(agent, NotificationTypes.CONVERSATION_SNOOZE_EXPIRED, [true, false, false, true])
    await row(admin, NotificationTypes.CONVERSATION_REOPENED, [true, false, false, false])
    // The other type's old default is not the old default of this one
    await row(agent, CONVERSATION_UNASSIGNED_QUEUE, [true, false, false, true])
    await row(ctx.adminA.id, NotificationTypes.MESSAGE_FAILED, [true, false, false, true])

    await migrate()
    await migrate() // a deploy that runs it again finds nothing more to remove

    expect(await has(admin, MESSAGE_RECEIVED)).toBe(false)
    expect(await has(viewer, CONVERSATION_UNASSIGNED_QUEUE)).toBe(false)
    expect(await has(agent, MESSAGE_RECEIVED)).toBe(true)
    expect(await has(admin, CONVERSATION_UNASSIGNED_QUEUE)).toBe(true)
    expect(await has(viewer, MESSAGE_RECEIVED)).toBe(true)
    expect(await has(agent, NotificationTypes.CONVERSATION_SNOOZE_EXPIRED)).toBe(true)
    expect(await has(admin, NotificationTypes.CONVERSATION_REOPENED)).toBe(true)
    expect(await has(agent, CONVERSATION_UNASSIGNED_QUEUE)).toBe(true)
    expect(await has(ctx.adminA.id, NotificationTypes.MESSAGE_FAILED)).toBe(true)
  })

  it('leaves the removed row to the new default, and a chosen one to its owner', async () => {
    const preferences = app.get(NotificationPreferencesService, { strict: false })
    const { MESSAGE_RECEIVED } = NotificationTypes
    await row(ctx.adminA.id, MESSAGE_RECEIVED, [true, false, false, true])
    await row(ctx.agentA.id, MESSAGE_RECEIVED, [true, false, true, true])
    // Each flag of the predicate decides: the old default with the app channel off is a choice
    await row(ctx.viewerA.id, NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, [
      false,
      false,
      false,
      false
    ])

    await migrate()

    const store = ctx.storeA.id
    expect(await preferences.resolve(ctx.adminA.id, store, MESSAGE_RECEIVED)).toEqual({
      inApp: true,
      push: true,
      email: false,
      sound: true
    })
    expect((await preferences.resolve(ctx.agentA.id, store, MESSAGE_RECEIVED)).push).toBe(false)
    // No row at all: the new default
    expect(await preferences.resolve(ctx.viewerA.id, store, MESSAGE_RECEIVED)).toEqual({
      inApp: true,
      push: true,
      email: false,
      sound: true
    })
    expect(
      await preferences.resolve(
        ctx.viewerA.id,
        store,
        NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE
      )
    ).toEqual({ inApp: false, push: false, email: false, sound: false })
  })
})
