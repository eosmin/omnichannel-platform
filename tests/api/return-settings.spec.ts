import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ReturnResourceTypes } from '@platform/core/domain'

import { resetStoreSettings } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403

// Who pays the return leg by default (TDD_17 §4.11, Step 4.12 PR R1b): the setting, its limits, its store and its audit
describe('The returns settings of a store', () => {
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
    await resetStoreSettings(owner, { storeId: ctx.storeA.id })
    await resetStoreSettings(owner, { storeId: ctx.storeA2.id })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  it('starts with the sender paying, and changes it', async () => {
    expect((await asAdmin().get(ApiRoutes.settings.returns)).body).toEqual({
      returnShippingPayer: 'sender'
    })

    const changed = await asAdmin()
      .patch(ApiRoutes.settings.returns)
      .send({ returnShippingPayer: 'recipient' })

    expect(changed.status).toBe(OK)
    expect(changed.body).toEqual({ returnShippingPayer: 'recipient' })
    expect((await asAdmin().get(ApiRoutes.settings.returns)).body).toEqual({
      returnShippingPayer: 'recipient'
    })
  })

  it('refuses a payer that does not exist, an empty body and a key it does not have', async () => {
    for (const body of [
      { returnShippingPayer: 'the-moon' },
      {},
      { storeId: ctx.storeA2.id },
      { returnShippingPayer: 'sender', other: true }
    ]) {
      expect((await asAdmin().patch(ApiRoutes.settings.returns).send(body)).status).toBe(
        BAD_REQUEST
      )
    }
  })

  it('belongs to the store of the request: another store of the organization keeps its own', async () => {
    await asAdmin().patch(ApiRoutes.settings.returns).send({ returnShippingPayer: 'recipient' })

    const sibling = await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.settings.returns)

    expect(sibling.body).toEqual({ returnShippingPayer: 'sender' })
  })

  it('asks for settings:view to read and settings:edit to change', async () => {
    const reader = await actorWithPermissions(owner, app, {
      prefix,
      name: 'returnSettingsReader',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_VIEW]
    })
    const writer = await actorWithPermissions(owner, app, {
      prefix,
      name: 'returnSettingsWriter',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_EDIT]
    })

    const asReader = api(app, reader, ctx.storeA)
    expect((await asReader.get(ApiRoutes.settings.returns)).status).toBe(OK)
    expect(
      (await asReader.patch(ApiRoutes.settings.returns).send({ returnShippingPayer: 'recipient' }))
        .status
    ).toBe(FORBIDDEN)
    const asWriter = api(app, writer, ctx.storeA)
    expect((await asWriter.get(ApiRoutes.settings.returns)).status).toBe(FORBIDDEN)
    expect(
      (await asWriter.patch(ApiRoutes.settings.returns).send({ returnShippingPayer: 'recipient' }))
        .status
    ).toBe(OK)
  })

  it('leaves one audit entry with what changed, and none for a request that changes nothing', async () => {
    const since = new Date()
    await asAdmin().patch(ApiRoutes.settings.returns).send({ returnShippingPayer: 'recipient' })
    await asAdmin().patch(ApiRoutes.settings.returns).send({ returnShippingPayer: 'recipient' })

    const where = {
      action: AuditAction.SETTINGS_CHANGED,
      storeId: ctx.storeA.id,
      resourceType: ReturnResourceTypes.RETURN_SETTINGS,
      timestamp: { gte: since }
    }
    await waitForAuditEntries(owner, where, 1)
    await new Promise(resolve => setTimeout(resolve, 400))
    const entries = await owner.auditLog.findMany({ where })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ userId: ctx.adminA.id })
    expect(entries[0]?.metadata).toMatchObject({
      change: 'updated',
      changes: { returnShippingPayer: { from: 'sender', to: 'recipient' } }
    })
  })
})
