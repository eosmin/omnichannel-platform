import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import {
  InventoryAdjustmentReason,
  InventoryLimits,
  InventoryMovementType,
  WarehouseConflicts,
  WarehouseLimits,
  WarehouseResourceTypes,
  WarehouseStockBlocks
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { InventoryService } from '@platform/core/inventory'

import { createInventoryLevel, createProduct, createWarehouse, linkWarehouse } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface WarehouseBody {
  id: string
  name: string
  code: string
  address: Record<string, string> | null
  active: boolean
  stores: { storeId: string; storeName: string; priority: number }[]
}
interface PageBody {
  data: WarehouseBody[]
  nextCursor: string | null
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

describe('The warehouses of an organization', () => {
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

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const code = (): string => `W${randomUUID().slice(0, 8).toUpperCase()}`
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const priorities = async (storeId: string): Promise<Record<string, number>> => {
    const rows = await owner.storeWarehouse.findMany({ where: { storeId } })
    return Object.fromEntries(rows.map(row => [row.warehouseId, row.priority]))
  }

  async function create(body: Record<string, unknown> = {}): Promise<WarehouseBody> {
    const response = await asAdmin()
      .post(ApiRoutes.warehouses.create)
      .send({ name: `Warehouse ${randomUUID().slice(0, 6)}`, code: code(), ...body })
    expect(response.status).toBe(CREATED)
    return response.body as WarehouseBody
  }

  describe('creating one', () => {
    it('puts it in the organization of the store of the request, active and linked to no store', async () => {
      const body = await create({ name: '  North depot  ', code: 'North-1' })

      expect(body).toMatchObject({
        name: 'North depot',
        code: 'North-1',
        address: null,
        active: true,
        stores: []
      })
      const row = await owner.warehouse.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.organizationId).toBe(ctx.orgA.id)
    })

    it('keeps an address of known fields only', async () => {
      const body = await create({
        address: { line1: '1 Main St', city: 'San Salvador', country: 'sv' }
      })
      expect(body.address).toEqual({ line1: '1 Main St', city: 'San Salvador', country: 'SV' })

      const unknown = await asAdmin()
        .post(ApiRoutes.warehouses.create)
        .send({ name: 'x', code: code(), address: { line1: 'a', city: 'b', secret: 'c' } })
      expect(unknown.status).toBe(BAD_REQUEST)
    })

    it.each([
      ['a code with an accent', 'Bodega-É'],
      ['a code with a space', 'AB 1'],
      ['a code that starts with a dot', '.AB'],
      ['an empty code', ''],
      ['a code too long', 'A'.repeat(InventoryLimits.WAREHOUSE_CODE_MAX_LENGTH + 1)]
    ])('refuses %s', async (_label, bad) => {
      const response = await asAdmin()
        .post(ApiRoutes.warehouses.create)
        .send({ name: 'x', code: bad })
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('refuses a body that names the organization, or anything else it does not know', async () => {
      for (const extra of [
        { organizationId: ctx.orgB.id },
        { active: false },
        { stores: [] },
        { id: randomUUID() }
      ]) {
        const response = await asAdmin()
          .post(ApiRoutes.warehouses.create)
          .send({ name: 'x', code: code(), ...extra })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('refuses a code that is taken in the organization, whatever its letter case', async () => {
      const taken = code()
      await create({ code: taken })

      const response = await asAdmin()
        .post(ApiRoutes.warehouses.create)
        .send({ name: 'again', code: taken.toLowerCase() })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.RESOURCE_ALREADY_EXISTS)
      expect(errorOf(response).metadata).toMatchObject({ conflict: WarehouseConflicts.CODE_IN_USE })
    })

    it('lets another organization use the same code', async () => {
      const shared = code()
      await create({ code: shared })

      const response = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.warehouses.create)
        .send({ name: 'same code, other organization', code: shared })

      expect(response.status).toBe(CREATED)
    })

    it('takes turns when two requests ask for the same code at the same moment', async () => {
      const shared = code()
      const answers = await Promise.all(
        [1, 2, 3].map(index =>
          asAdmin()
            .post(ApiRoutes.warehouses.create)
            .send({ name: `race ${index}`, code: shared })
        )
      )

      expect(answers.filter(answer => answer.status === CREATED)).toHaveLength(1)
      expect(answers.filter(answer => answer.status === CONFLICT)).toHaveLength(2)
    })

    it('leaves one audit entry with the warehouse', async () => {
      const body = await create()

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.WAREHOUSE_CREATED,
        resourceId: body.id
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        userId: ctx.adminA.id,
        resourceType: WarehouseResourceTypes.WAREHOUSE
      })
    })

    it('stops at the number of warehouses an organization may hold', async () => {
      const full = await owner.organization.create({
        data: { name: `${prefix}-full`, slug: `${prefix}-full` }
      })
      const store = await ensureStore(owner, full.id, `${prefix}-full-store`)
      const member = await createActor(owner, app, {
        prefix,
        name: 'fullAdmin',
        organizationId: full.id,
        storeId: store.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      await owner.warehouse.createMany({
        data: Array.from({ length: WarehouseLimits.MAX_PER_ORGANIZATION }, (_, index) => ({
          organizationId: full.id,
          name: `bulk ${index}`,
          code: `B${index}`
        }))
      })

      const response = await api(app, member, store)
        .post(ApiRoutes.warehouses.create)
        .send({ name: 'one too many', code: 'EXTRA' })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({
        limit: WarehouseLimits.MAX_PER_ORGANIZATION
      })
    })
  })

  describe('who may do what', () => {
    it('lets whoever may view inventory read, and only who manages warehouses write', async () => {
      const target = await create()

      for (const reader of [ctx.agentA, ctx.viewerA]) {
        const as = api(app, reader, ctx.storeA)
        expect((await as.get(ApiRoutes.warehouses.list)).status).toBe(OK)
        expect((await as.get(ApiRoutes.warehouses.byId(target.id))).status).toBe(OK)
        expect(
          (await as.post(ApiRoutes.warehouses.create).send({ name: 'x', code: code() })).status
        ).toBe(FORBIDDEN)
        expect(
          (await as.patch(ApiRoutes.warehouses.byId(target.id)).send({ name: 'y' })).status
        ).toBe(FORBIDDEN)
        expect(
          (await as.put(ApiRoutes.warehouses.stores(target.id)).send({ stores: [] })).status
        ).toBe(FORBIDDEN)
      }
    })

    it('asks for the permission to view inventory, not for another one', async () => {
      const onlyManage = await actorWithPermissions(owner, app, {
        prefix,
        name: 'onlyManage',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.ORG_MANAGE_WAREHOUSES]
      })
      const onlyView = await actorWithPermissions(owner, app, {
        prefix,
        name: 'onlyView',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.INVENTORY_VIEW]
      })
      const target = await create()

      // Managing does not bring the right to read (the TDD names one permission for each)
      expect((await api(app, onlyManage, ctx.storeA).get(ApiRoutes.warehouses.list)).status).toBe(
        FORBIDDEN
      )
      expect(
        (
          await api(app, onlyManage, ctx.storeA)
            .patch(ApiRoutes.warehouses.byId(target.id))
            .send({ name: 'renamed' })
        ).status
      ).toBe(OK)
      expect((await api(app, onlyView, ctx.storeA).get(ApiRoutes.warehouses.list)).status).toBe(OK)
      expect(
        (
          await api(app, onlyView, ctx.storeA)
            .patch(ApiRoutes.warehouses.byId(target.id))
            .send({ name: 'nope' })
        ).status
      ).toBe(FORBIDDEN)
    })
  })

  describe('listing and reading them', () => {
    it('shows the warehouses of the organization, with the stores each one serves', async () => {
      const response = await asAdmin().get(ApiRoutes.warehouses.list).query({ limit: 100 })

      expect(response.status).toBe(OK)
      const list = (response.body as PageBody).data
      const main = list.find(row => row.id === ctx.warehouseA.id)
      expect(main?.stores.map(link => link.storeId).sort()).toEqual(
        [ctx.storeA.id, ctx.storeA2.id].sort()
      )
      expect(main?.stores.every(link => link.priority === 1)).toBe(true)
      expect(list.some(row => row.id === ctx.warehouseASecond.id)).toBe(true)
      // The warehouses of the other organization are not in it
      expect(list.some(row => row.id === ctx.warehouseB.id)).toBe(false)
    })

    it('is the same list from another store of the organization, and another one from the other organization', async () => {
      const fromSibling = await api(app, ctx.adminA2, ctx.storeA2)
        .get(ApiRoutes.warehouses.list)
        .query({ limit: 100 })
      const fromOther = await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.warehouses.list)
        .query({ limit: 100 })

      const siblingIds = (fromSibling.body as PageBody).data.map(row => row.id)
      expect(siblingIds).toContain(ctx.warehouseASecond.id)
      const otherIds = (fromOther.body as PageBody).data.map(row => row.id)
      expect(otherIds).toContain(ctx.warehouseB.id)
      expect(otherIds).not.toContain(ctx.warehouseA.id)
      expect(otherIds).not.toContain(ctx.warehouseASecond.id)
    })

    it('pages with a cursor and filters by active', async () => {
      const made = [await create(), await create(), await create()]
      await asAdmin()
        .patch(ApiRoutes.warehouses.byId(made[0]?.id ?? ''))
        .send({ active: false })

      const seen: string[] = []
      let cursor: string | null = null
      do {
        const response = await asAdmin()
          .get(ApiRoutes.warehouses.list)
          .query({ limit: 2, ...(cursor === null ? {} : { cursor }) })
        expect(response.status).toBe(OK)
        const page = response.body as PageBody
        seen.push(...page.data.map(row => row.id))
        cursor = page.nextCursor
      } while (cursor !== null)
      expect(new Set(seen).size).toBe(seen.length)
      for (const warehouse of made) expect(seen).toContain(warehouse.id)

      const inactive = await asAdmin()
        .get(ApiRoutes.warehouses.list)
        .query({ active: 'false', limit: 100 })
      const ids = (inactive.body as PageBody).data.map(row => row.id)
      expect(ids).toContain(made[0]?.id)
      expect(ids).not.toContain(made[1]?.id)
    })

    it('answers the same 404 for a warehouse of another organization as for one that does not exist', async () => {
      const foreign = await asAdmin().get(ApiRoutes.warehouses.byId(ctx.warehouseB.id))
      const missing = await asAdmin().get(ApiRoutes.warehouses.byId(randomUUID()))

      expect(foreign.status).toBe(NOT_FOUND)
      expect(missing.status).toBe(NOT_FOUND)
      expect(errorOf(foreign)).toEqual(errorOf(missing))
    })

    it('refuses an id that is not a uuid', async () => {
      expect((await asAdmin().get(ApiRoutes.warehouses.byId('nope'))).status).toBe(BAD_REQUEST)
    })
  })

  describe('changing one', () => {
    it('renames it, changes its code and clears its address', async () => {
      const body = await create({ address: { line1: 'a', city: 'b' } })
      const next = code()

      const response = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(body.id))
        .send({ name: 'Renamed', code: next, address: null })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ name: 'Renamed', code: next, address: null })
    })

    it('refuses an empty body, an unknown key and a code that another warehouse holds', async () => {
      const first = await create()
      const second = await create()

      for (const bad of [{}, { organizationId: ctx.orgB.id }, { stores: [] }]) {
        const response = await asAdmin().patch(ApiRoutes.warehouses.byId(first.id)).send(bad)
        expect(response.status).toBe(BAD_REQUEST)
      }
      const taken = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(first.id))
        .send({ code: second.code.toLowerCase() })
      expect(taken.status).toBe(CONFLICT)
      expect(errorOf(taken).metadata).toMatchObject({ conflict: WarehouseConflicts.CODE_IN_USE })
      // Its own code, in another letter case, is the same warehouse and not a clash
      const ownCase = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(first.id))
        .send({ code: first.code.toLowerCase() })
      expect(ownCase.status).toBe(OK)
    })

    it('cannot touch a warehouse of another organization', async () => {
      const before = await owner.warehouse.findUniqueOrThrow({ where: { id: ctx.warehouseB.id } })

      const response = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(ctx.warehouseB.id))
        .send({ name: 'taken over', active: false })

      expect(response.status).toBe(NOT_FOUND)
      const after = await owner.warehouse.findUniqueOrThrow({ where: { id: ctx.warehouseB.id } })
      expect(after.name).toBe(before.name)
      expect(after.active).toBe(true)
    })

    it('records what changed', async () => {
      const body = await create()

      await asAdmin()
        .patch(ApiRoutes.warehouses.byId(body.id))
        .send({ name: 'Audited', active: false })

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.WAREHOUSE_UPDATED,
        resourceId: body.id
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.metadata).toMatchObject({
        fields: expect.arrayContaining(['name', 'active']) as string[]
      })
    })
  })

  describe('switching one off', () => {
    it('is allowed when it holds no units and no reservation, and can be switched on again', async () => {
      const body = await create()

      const off = await asAdmin().patch(ApiRoutes.warehouses.byId(body.id)).send({ active: false })
      const on = await asAdmin().patch(ApiRoutes.warehouses.byId(body.id)).send({ active: true })

      expect(off.status).toBe(OK)
      expect((off.body as WarehouseBody).active).toBe(false)
      expect((on.body as WarehouseBody).active).toBe(true)
    })

    it('is allowed when its levels are all at zero', async () => {
      const body = await create()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: body.id,
        onHand: 0
      })

      const response = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(body.id))
        .send({ active: false })

      expect(response.status).toBe(OK)
    })

    it('is refused while a store keeps units in it, even a store the caller does not work in', async () => {
      const body = await create()
      const product = await createProduct(owner, { storeId: ctx.storeA2.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA2.id,
        productId: product.id,
        warehouseId: body.id,
        onHand: 3
      })

      const response = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(body.id))
        .send({ active: false })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_HAS_STOCK)
      expect(errorOf(response).metadata).toMatchObject({
        reason: WarehouseStockBlocks.DEACTIVATE
      })
      const row = await owner.warehouse.findUniqueOrThrow({ where: { id: body.id } })
      expect(row.active).toBe(true)
    })

    it('is refused while units are reserved in it, and while a level is negative', async () => {
      for (const level of [{ onHand: 0, reserved: 2 }, { onHand: -1 }]) {
        const body = await create()
        const product = await createProduct(owner, { storeId: ctx.storeA.id })
        await createInventoryLevel(owner, {
          storeId: ctx.storeA.id,
          productId: product.id,
          warehouseId: body.id,
          ...level
        })

        const response = await asAdmin()
          .patch(ApiRoutes.warehouses.byId(body.id))
          .send({ active: false })

        expect(response.status).toBe(CONFLICT)
        expect(errorOf(response).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_HAS_STOCK)
      }
    })

    it('does not refuse a change that leaves it on', async () => {
      const body = await create()
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: body.id,
        onHand: 5
      })

      const response = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(body.id))
        .send({ name: 'Still on', active: true })

      expect(response.status).toBe(OK)
    })
  })

  describe('linking it to stores', () => {
    it('links the stores named, at the end of each one, and unlinks the ones left out', async () => {
      const body = await create()
      const before = await priorities(ctx.storeA.id)

      const response = await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }, { storeId: ctx.storeA2.id }] })

      expect(response.status).toBe(OK)
      const linked = (response.body as WarehouseBody).stores
      expect(linked.map(link => link.storeId).sort()).toEqual(
        [ctx.storeA.id, ctx.storeA2.id].sort()
      )
      // The end of each store's list: A already had two, A2 had one
      const after = await priorities(ctx.storeA.id)
      expect(after[body.id]).toBe(Object.keys(before).length + 1)
      expect(Object.values(await priorities(ctx.storeA2.id)).sort()).toEqual([1, 2])

      const unlink = await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }] })
      expect(unlink.status).toBe(OK)
      expect((unlink.body as WarehouseBody).stores).toHaveLength(1)
      expect(await owner.storeWarehouse.count({ where: { warehouseId: body.id } })).toBe(1)
    })

    it('moves a warehouse to a priority and shifts the others, in one step, without a clash', async () => {
      // Store A: warehouse A at 1 and the second at 2 (the context). The second takes the first place.
      const response = await asAdmin()
        .put(ApiRoutes.warehouses.stores(ctx.warehouseASecond.id))
        .send({ stores: [{ storeId: ctx.storeA.id, priority: 1 }] })

      expect(response.status).toBe(OK)
      const now = await priorities(ctx.storeA.id)
      expect(now[ctx.warehouseASecond.id]).toBe(1)
      expect(now[ctx.warehouseA.id]).toBe(2)

      // And back, so the other cases find the context as it was
      await asAdmin()
        .put(ApiRoutes.warehouses.stores(ctx.warehouseA.id))
        .send({
          stores: [
            { storeId: ctx.storeA.id, priority: 1 },
            { storeId: ctx.storeA2.id, priority: 1 }
          ]
        })
      const back = await priorities(ctx.storeA.id)
      expect(back[ctx.warehouseA.id]).toBe(1)
      expect(back[ctx.warehouseASecond.id]).toBe(2)
    })

    it('puts a priority past the end at the end, and keeps the priorities of a store whole', async () => {
      const store = await ensureStore(owner, ctx.orgA.id, `${prefix}-s`)
      const [first, second, third] = [await create(), await create(), await create()]
      for (const [warehouse, priority] of [
        [first, undefined],
        [second, WarehouseLimits.MAX_STORES_PER_REQUEST],
        [third, 1]
      ] as const) {
        const response = await asAdmin()
          .put(ApiRoutes.warehouses.stores(warehouse?.id ?? ''))
          .send({
            stores: [{ storeId: store.id, ...(priority === undefined ? {} : { priority }) }]
          })
        expect(response.status).toBe(OK)
      }

      const now = await priorities(store.id)
      expect(now[third?.id ?? '']).toBe(1)
      expect(now[first?.id ?? '']).toBe(2)
      expect(now[second?.id ?? '']).toBe(3)
    })

    it('stays whole when two requests link different warehouses to the same store at once', async () => {
      const store = await ensureStore(owner, ctx.orgA.id, `${prefix}-race`)
      const warehouses = await Promise.all([create(), create(), create(), create()])

      const answers = await Promise.all(
        warehouses.map(warehouse =>
          asAdmin()
            .put(ApiRoutes.warehouses.stores(warehouse.id))
            .send({ stores: [{ storeId: store.id, priority: 1 }] })
        )
      )

      expect(answers.every(answer => answer.status === OK)).toBe(true)
      const now = Object.values(await priorities(store.id)).sort()
      expect(now).toEqual([1, 2, 3, 4])
    })

    it('refuses a store of another organization, and links nothing from the same request', async () => {
      const body = await create()

      const response = await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }, { storeId: ctx.storeB.id }] })

      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.storeWarehouse.count({ where: { warehouseId: body.id } })).toBe(0)
      // A store that does not exist gets the same answer
      const missing = await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: randomUUID() }] })
      expect(missing.status).toBe(NOT_FOUND)
      expect(errorOf(missing)).toEqual(errorOf(response))
    })

    it('cannot link a warehouse of another organization to a store of this one', async () => {
      const response = await asAdmin()
        .put(ApiRoutes.warehouses.stores(ctx.warehouseB.id))
        .send({ stores: [{ storeId: ctx.storeA.id }] })

      expect(response.status).toBe(NOT_FOUND)
      expect(
        await owner.storeWarehouse.count({
          where: { warehouseId: ctx.warehouseB.id, storeId: ctx.storeA.id }
        })
      ).toBe(0)
    })

    it('refuses a store named twice, a priority below one and a body with anything else', async () => {
      const body = await create()
      for (const bad of [
        { stores: [{ storeId: ctx.storeA.id }, { storeId: ctx.storeA.id, priority: 2 }] },
        { stores: [{ storeId: ctx.storeA.id, priority: 0 }] },
        { stores: [{ storeId: ctx.storeA.id, priority: 1.5 }] },
        { stores: [{ storeId: 'nope' }] },
        { stores: [{ storeId: ctx.storeA.id, organizationId: ctx.orgB.id }] },
        { stores: [], organizationId: ctx.orgB.id },
        {}
      ]) {
        const response = await asAdmin().put(ApiRoutes.warehouses.stores(body.id)).send(bad)
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('does not give a new link to a warehouse that is switched off, but lets its links be removed', async () => {
      const body = await create()
      await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }] })
      await asAdmin().patch(ApiRoutes.warehouses.byId(body.id)).send({ active: false })

      const more = await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }, { storeId: ctx.storeA2.id }] })
      expect(more.status).toBe(CONFLICT)
      expect(errorOf(more).metadata).toMatchObject({ conflict: WarehouseConflicts.INACTIVE })

      const fewer = await asAdmin().put(ApiRoutes.warehouses.stores(body.id)).send({ stores: [] })
      expect(fewer.status).toBe(OK)
    })

    it('refuses to unlink a store that has units reserved there, and changes nothing', async () => {
      const body = await create()
      await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }, { storeId: ctx.storeA2.id }] })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: body.id,
        onHand: 4,
        reserved: 2
      })

      // A2 may go (it reserves nothing there), A may not: the whole request is refused
      const response = await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [] })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_HAS_STOCK)
      expect(errorOf(response).metadata).toMatchObject({
        reason: WarehouseStockBlocks.UNLINK,
        storeId: ctx.storeA.id
      })
      expect(await owner.storeWarehouse.count({ where: { warehouseId: body.id } })).toBe(2)
    })

    it('lets a store be unlinked when it only has units on hand, not reserved (TDD_16 §4.7)', async () => {
      const body = await create()
      await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }] })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: body.id,
        onHand: 4
      })

      const response = await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [] })

      expect(response.status).toBe(OK)
    })

    it('records the change of the links', async () => {
      const body = await create()
      await asAdmin()
        .put(ApiRoutes.warehouses.stores(body.id))
        .send({ stores: [{ storeId: ctx.storeA.id }] })

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.WAREHOUSE_UPDATED,
        resourceId: body.id
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.metadata).toMatchObject({ change: 'stores' })
    })
  })

  it('leaves no audit entry for a request that changes nothing', async () => {
    const body = await create({ address: { line1: 'a', city: 'b' } })
    await asAdmin()
      .put(ApiRoutes.warehouses.stores(body.id))
      .send({ stores: [{ storeId: ctx.storeA.id }] })
    await waitForAuditEntries(
      owner,
      { resourceId: body.id, action: AuditAction.WAREHOUSE_UPDATED },
      1
    )

    await asAdmin()
      .put(ApiRoutes.warehouses.stores(body.id))
      .send({ stores: [{ storeId: ctx.storeA.id }] })
    await asAdmin()
      .patch(ApiRoutes.warehouses.byId(body.id))
      .send({ name: body.name, address: { line1: 'a', city: 'b' } })
    // A real change after the no-ops is the marker: its entry is awaited, and the ones before it are the only others
    await asAdmin()
      .patch(ApiRoutes.warehouses.byId(body.id))
      .send({ address: { line1: 'z', city: 'b' } })
    const entries = await waitForAuditEntries(
      owner,
      { resourceId: body.id, action: AuditAction.WAREHOUSE_UPDATED },
      2
    )
    // The two no-op requests wrote nothing: the first link and this address are all there is
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(
      await owner.auditLog.count({
        where: { resourceId: body.id, action: AuditAction.WAREHOUSE_UPDATED }
      })
    ).toBe(2)
    expect(entries.map(entry => (entry.metadata as { fields: string[] }).fields)).toContainEqual([
      'address'
    ])
  })

  it('has a warehouse made by the context that a store of another organization cannot reach', async () => {
    const other = await createWarehouse(owner, { organizationId: ctx.orgB.id })
    await linkWarehouse(owner, {
      organizationId: ctx.orgB.id,
      storeId: ctx.storeB.id,
      warehouseId: other.id
    })

    const response = await asAdmin().get(ApiRoutes.warehouses.byId(other.id))

    expect(response.status).toBe(NOT_FOUND)
  })
  // The routes against the engine, both real: a movement and the switch-off (or the unlinking) of the warehouse start
  // together, and whoever wins, the warehouse is never left switched off or unlinked with units in it (TDD_16 §4.7). Each
  // round has a warehouse of its own; the outcome of a round is one of the two orders, never a mix.
  describe('a warehouse switched off or unlinked while stock moves in it', () => {
    const ROUNDS = 12
    const key = (): string => `${prefix}-${randomUUID()}`
    // Made by the owner, not through the api: the rate limit of the api counts the requests of the whole suite, and
    // every round needs only the one request that is being raced
    async function aLinkedWarehouse() {
      const warehouse = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      await linkWarehouse(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        warehouseId: warehouse.id
      })
      return warehouse
    }

    it('never ends switched off with units in it when a receipt arrives at the same moment', async () => {
      const inventory = app.get(InventoryService, { strict: false })
      for (let round = 0; round < ROUNDS; round += 1) {
        const body = await aLinkedWarehouse()
        const product = await createProduct(owner, { storeId: ctx.storeA.id })

        const [off, receipt] = await Promise.allSettled([
          asAdmin().patch(ApiRoutes.warehouses.byId(body.id)).send({ active: false }),
          inventory.move({
            storeId: ctx.storeA.id,
            productId: product.id,
            warehouseId: body.id,
            type: InventoryMovementType.RECEIPT,
            quantity: 2,
            reason: InventoryAdjustmentReason.FOUND,
            idempotencyKey: key()
          })
        ])

        const row = await owner.warehouse.findUniqueOrThrow({ where: { id: body.id } })
        const units = await owner.inventoryLevel.aggregate({
          where: { warehouseId: body.id },
          _sum: { onHand: true, reserved: true }
        })
        const held = (units._sum.onHand ?? 0) + (units._sum.reserved ?? 0)
        expect(off.status).toBe('fulfilled')
        const offStatus = off.status === 'fulfilled' ? off.value.status : 0
        // Only the two orders of the race are answers: a 429 or a 500 is a failure of the test, not a third order
        expect([OK, CONFLICT]).toContain(offStatus)
        if (offStatus === OK) {
          // Switched off first: the receipt was refused and nothing came in
          expect(receipt).toMatchObject({
            status: 'rejected',
            reason: { code: ErrorCodes.INVENTORY_WAREHOUSE_INACTIVE }
          })
          expect([row.active, held]).toEqual([false, 0])
        } else {
          // The receipt first: the switch-off saw the units and was refused
          expect(off).toMatchObject({ status: 'fulfilled', value: { status: CONFLICT } })
          expect(receipt.status).toBe('fulfilled')
          expect([row.active, held]).toEqual([true, 2])
        }
      }
    })

    it('never ends unlinked with units reserved when a reservation arrives at the same moment', async () => {
      const inventory = app.get(InventoryService, { strict: false })
      for (let round = 0; round < ROUNDS; round += 1) {
        const body = await aLinkedWarehouse()
        const product = await createProduct(owner, { storeId: ctx.storeA.id })
        await createInventoryLevel(owner, {
          storeId: ctx.storeA.id,
          productId: product.id,
          warehouseId: body.id,
          onHand: 5
        })

        const [unlink, reservation] = await Promise.allSettled([
          asAdmin().put(ApiRoutes.warehouses.stores(body.id)).send({ stores: [] }),
          inventory.reserve({
            storeId: ctx.storeA.id,
            productId: product.id,
            warehouseId: body.id,
            quantity: 1,
            idempotencyKey: key()
          })
        ])

        const linked = await owner.storeWarehouse.count({
          where: { storeId: ctx.storeA.id, warehouseId: body.id }
        })
        const level = await owner.inventoryLevel.findFirstOrThrow({
          where: { warehouseId: body.id, productId: product.id }
        })
        expect(unlink.status).toBe('fulfilled')
        const unlinkStatus = unlink.status === 'fulfilled' ? unlink.value.status : 0
        expect([OK, CONFLICT]).toContain(unlinkStatus)
        if (unlinkStatus === OK) {
          expect(reservation).toMatchObject({
            status: 'rejected',
            reason: { code: ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED }
          })
          expect([linked, level.reserved]).toEqual([0, 0])
        } else {
          expect(unlink).toMatchObject({ status: 'fulfilled', value: { status: CONFLICT } })
          expect(reservation.status).toBe('fulfilled')
          expect([linked, level.reserved]).toEqual([1, 1])
        }
      }
    })
  })
})
