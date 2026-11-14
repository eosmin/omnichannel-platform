import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ModerateRiskModes, type SafetySettings } from '@platform/core/domain'

import { resetStoreSettings } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403

const FACTORY: SafetySettings = {
  confirmDeleteCustomer: true,
  confirmDisconnectChannel: true,
  confirmRemoveMember: true,
  applyToRoles: [RoleNames.AGENT, RoleNames.SUPERVISOR],
  moderateRiskMode: ModerateRiskModes.DIALOG
}

// Settings → Safety and confirmations (TDD_09 §11.2, Step 5.4 PR C): how a store asks before the destructive actions of
// the HIGH and MODERATE tiers. Every confirmation is on until the store lowers it.
describe('The safety and confirmation settings of a store', () => {
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
    for (const store of [ctx.storeA, ctx.storeA2, ctx.storeB]) {
      await resetStoreSettings(owner, { storeId: store.id })
    }
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const stored = async (storeId: string): Promise<unknown> =>
    (await owner.storeSettings.findUniqueOrThrow({ where: { storeId }, select: { safety: true } }))
      .safety

  it('asks for everything in a store that never opened the page', async () => {
    const response = await asAdmin().get(ApiRoutes.settings.safety)

    expect(response.status).toBe(OK)
    expect(response.body).toEqual(FACTORY)
  })

  it('is read by whoever works the inbox, and changed only by who may edit settings', async () => {
    await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.settings.safety).expect(OK)
    await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.settings.safety).expect(OK)

    for (const actor of [ctx.agentA, ctx.viewerA]) {
      await api(app, actor, ctx.storeA)
        .put(ApiRoutes.settings.safety)
        .send({ confirmDeleteCustomer: false })
        .expect(FORBIDDEN)
    }
    expect(await stored(ctx.storeA.id)).toEqual({})
  })

  it('changes the keys it is given and keeps the others', async () => {
    await asAdmin()
      .put(ApiRoutes.settings.safety)
      .send({ confirmDeleteCustomer: false, moderateRiskMode: ModerateRiskModes.UNDO })
      .expect(OK)
    const response = await asAdmin()
      .put(ApiRoutes.settings.safety)
      .send({ applyToRoles: [RoleNames.AGENT] })
      .expect(OK)

    expect(response.body).toEqual({
      ...FACTORY,
      confirmDeleteCustomer: false,
      moderateRiskMode: ModerateRiskModes.UNDO,
      applyToRoles: [RoleNames.AGENT]
    })
    const reread = await asAdmin().get(ApiRoutes.settings.safety).expect(OK)
    expect(reread.body).toEqual(response.body)
  })

  it('refuses what is not a setting, a role it does not know, a repeated role, a mode it does not have and an empty change', async () => {
    for (const body of [
      { confirmDeleteStore: false },
      { applyToRoles: ['Owner'] },
      { applyToRoles: [RoleNames.AGENT, RoleNames.AGENT] },
      { moderateRiskMode: 'sometimes' },
      { confirmRemoveMember: 'no' },
      {}
    ]) {
      await asAdmin().put(ApiRoutes.settings.safety).send(body).expect(BAD_REQUEST)
    }
    expect(await stored(ctx.storeA.id)).toEqual({})
  })

  it('reads a damaged column as the safe defaults and never as no confirmation', async () => {
    await owner.storeSettings.update({
      where: { storeId: ctx.storeA.id },
      data: {
        safety: { confirmRemoveMember: 'nope', applyToRoles: 'everyone', moderateRiskMode: 7 }
      }
    })

    const response = await asAdmin().get(ApiRoutes.settings.safety)

    expect(response.status).toBe(OK)
    expect(response.body).toEqual(FACTORY)
  })

  it('belongs to the store of the request: another store neither reads nor changes it', async () => {
    await asAdmin().put(ApiRoutes.settings.safety).send({ confirmRemoveMember: false }).expect(OK)

    const sibling = await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.settings.safety)
    const other = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.settings.safety)
    // An admin of another store cannot reach the store of A by naming it
    await api(app, ctx.adminB, ctx.storeA).get(ApiRoutes.settings.safety).expect(FORBIDDEN)

    expect(sibling.body).toEqual(FACTORY)
    expect(other.body).toEqual(FACTORY)
  })

  it('audits what changed, from what to what, and leaves no entry for a request that changes nothing', async () => {
    const since = new Date()
    await asAdmin().put(ApiRoutes.settings.safety).send({ confirmDeleteCustomer: true }).expect(OK)
    await asAdmin().put(ApiRoutes.settings.safety).send({ confirmDeleteCustomer: false }).expect(OK)

    const entries = await waitForAuditEntries(owner, {
      storeId: ctx.storeA.id,
      action: AuditAction.SETTINGS_CHANGED,
      resourceType: 'store_safety_settings',
      timestamp: { gte: since }
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.metadata).toMatchObject({
      fields: ['confirmDeleteCustomer'],
      changes: { confirmDeleteCustomer: { from: true, to: false } }
    })
  })
})
