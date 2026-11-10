import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ProductLimits, WarehouseResourceTypes } from '@platform/core/domain'

import { resetStoreSettings } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface InventorySettingsBody {
  allowNegativeStock: boolean
  allowSplitFulfillment: boolean
  defaultLowStockThreshold: number | null
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403

describe('The inventory settings of a store', () => {
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

  it('starts with negative stock and split fulfillment off and no default threshold', async () => {
    const response = await asAdmin().get(ApiRoutes.settings.inventory)

    expect(response.status).toBe(OK)
    expect(response.body).toEqual({
      allowNegativeStock: false,
      allowSplitFulfillment: false,
      defaultLowStockThreshold: null
    })
  })

  it('changes only the switches that the body names', async () => {
    const first = await asAdmin()
      .patch(ApiRoutes.settings.inventory)
      .send({ allowNegativeStock: true, defaultLowStockThreshold: 5 })
    const second = await asAdmin()
      .patch(ApiRoutes.settings.inventory)
      .send({ allowSplitFulfillment: true })

    expect(first.status).toBe(OK)
    expect(first.body as InventorySettingsBody).toEqual({
      allowNegativeStock: true,
      allowSplitFulfillment: false,
      defaultLowStockThreshold: 5
    })
    expect(second.body as InventorySettingsBody).toEqual({
      allowNegativeStock: true,
      allowSplitFulfillment: true,
      defaultLowStockThreshold: 5
    })
    const row = await owner.storeSettings.findUniqueOrThrow({ where: { storeId: ctx.storeA.id } })
    expect(row).toMatchObject({
      allowNegativeStock: true,
      allowSplitFulfillment: true,
      defaultLowStockThreshold: 5
    })
  })

  it('clears the default threshold with null and accepts zero', async () => {
    await asAdmin().patch(ApiRoutes.settings.inventory).send({ defaultLowStockThreshold: 0 })
    const zero = await asAdmin().get(ApiRoutes.settings.inventory)
    expect((zero.body as InventorySettingsBody).defaultLowStockThreshold).toBe(0)

    await asAdmin().patch(ApiRoutes.settings.inventory).send({ defaultLowStockThreshold: null })
    const none = await asAdmin().get(ApiRoutes.settings.inventory)
    expect((none.body as InventorySettingsBody).defaultLowStockThreshold).toBeNull()
  })

  it('refuses what is not a switch or a whole number inside the limits', async () => {
    for (const bad of [
      {},
      { allowNegativeStock: 'yes' },
      { allowNegativeStock: null },
      { defaultLowStockThreshold: -1 },
      { defaultLowStockThreshold: 1.5 },
      { defaultLowStockThreshold: '5' },
      { defaultLowStockThreshold: ProductLimits.MAX_LOW_STOCK_THRESHOLD + 1 },
      { storeId: ctx.storeA2.id },
      { unknown: true }
    ]) {
      const response = await asAdmin().patch(ApiRoutes.settings.inventory).send(bad)
      expect(response.status).toBe(BAD_REQUEST)
    }
    const row = await owner.storeSettings.findUniqueOrThrow({ where: { storeId: ctx.storeA.id } })
    expect(row.allowNegativeStock).toBe(false)
  })

  it('belongs to the store of the request: another store of the organization keeps its own', async () => {
    await asAdmin().patch(ApiRoutes.settings.inventory).send({ allowNegativeStock: true })

    const sibling = await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.settings.inventory)
    expect((sibling.body as InventorySettingsBody).allowNegativeStock).toBe(false)
    const other = await owner.storeSettings.findUniqueOrThrow({
      where: { storeId: ctx.storeA2.id }
    })
    expect(other.allowNegativeStock).toBe(false)
  })

  it('asks for settings:view to read and settings:edit to change', async () => {
    const reader = await actorWithPermissions(owner, app, {
      prefix,
      name: 'settingsReader',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_VIEW]
    })
    const writer = await actorWithPermissions(owner, app, {
      prefix,
      name: 'settingsWriter',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.SETTINGS_EDIT]
    })

    const asReader = api(app, reader, ctx.storeA)
    expect((await asReader.get(ApiRoutes.settings.inventory)).status).toBe(OK)
    expect(
      (await asReader.patch(ApiRoutes.settings.inventory).send({ allowNegativeStock: true })).status
    ).toBe(FORBIDDEN)
    const asWriter = api(app, writer, ctx.storeA)
    expect((await asWriter.get(ApiRoutes.settings.inventory)).status).toBe(FORBIDDEN)
    expect(
      (await asWriter.patch(ApiRoutes.settings.inventory).send({ allowNegativeStock: true })).status
    ).toBe(OK)
  })

  it('leaves an audit entry with what changed, and none for a request that changes nothing', async () => {
    // The cases before this one wrote entries for the same store
    const since = new Date()
    await asAdmin()
      .patch(ApiRoutes.settings.inventory)
      .send({ allowNegativeStock: true, defaultLowStockThreshold: 3 })
    // The same values again, and a switch left as it is
    await asAdmin()
      .patch(ApiRoutes.settings.inventory)
      .send({ allowNegativeStock: true, allowSplitFulfillment: false })

    const where = {
      action: AuditAction.SETTINGS_CHANGED,
      storeId: ctx.storeA.id,
      resourceType: WarehouseResourceTypes.INVENTORY_SETTINGS,
      timestamp: { gte: since }
    }
    await waitForAuditEntries(owner, where, 1)
    await new Promise(resolve => setTimeout(resolve, 400))
    const entries = await owner.auditLog.findMany({ where })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ userId: ctx.adminA.id })
    expect(entries[0]?.metadata).toMatchObject({
      change: 'updated',
      changes: {
        allowNegativeStock: { from: false, to: true },
        defaultLowStockThreshold: { from: null, to: 3 }
      }
    })
  })

  it('is the default a new product starts with, and a product that exists keeps its own', async () => {
    const existing = await asAdmin()
      .post(ApiRoutes.products.create)
      .send({ name: 'Before', priceCents: 100 })
    await asAdmin().patch(ApiRoutes.settings.inventory).send({ defaultLowStockThreshold: 7 })
    const created = await asAdmin()
      .post(ApiRoutes.products.create)
      .send({ name: 'After', priceCents: 100 })

    expect((created.body as { lowStockThreshold: number | null }).lowStockThreshold).toBe(7)
    const row = await owner.product.findUniqueOrThrow({
      where: { id: (existing.body as { id: string }).id }
    })
    expect(row.lowStockThreshold).toBeNull()
  })
})
