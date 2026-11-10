import { randomUUID } from 'node:crypto'

import { RoleNames, RolePresets, Permissions } from '@platform/core/auth'
import {
  connectionUrls,
  createOwnerClient,
  ensureDefaultWarehouse,
  ensureStoreWarehouse,
  ensureWarehouse,
  type OwnerClient
} from '@platform/core/database-testing'
import { InventoryMovementType } from '@platform/core/domain'

import {
  createInventoryLevel,
  createInventoryMovement,
  createProduct,
  createProductVariant,
  createWarehouse,
  linkWarehouse
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// What the database itself guarantees about stock (TDD_16 §2, §8), before any service writes to it: the rules the
// tenancy of the warehouses and of the stock stand on, so that a bug of a service cannot break them. The routes
// that read and write this data (and their isolation cases in tenant-isolation.spec) arrive with Steps 4.2 and 4.3.
describe('The tables of stock and warehouses', () => {
  const prefix = newRunPrefix()
  let owner: OwnerClient
  let app: Awaited<ReturnType<typeof createTestApp>>
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

  // What the database says when it refuses: the name of the constraint is in the message
  const refused = (statement: Promise<unknown>, constraint: string | RegExp) =>
    expect(statement).rejects.toThrow(constraint)

  describe('the warehouses of an organization', () => {
    it('are shared by the stores of that organization and by no other', async () => {
      // The seed: warehouse A serves stores A and A2 (one organization), a second one serves store A only
      const links = await owner.storeWarehouse.findMany({
        where: { organizationId: ctx.orgA.id },
        orderBy: [{ storeId: 'asc' }, { priority: 'asc' }]
      })
      expect(links.filter(link => link.warehouseId === ctx.warehouseA.id)).toHaveLength(2)
      expect(
        links.find(
          link => link.storeId === ctx.storeA.id && link.warehouseId === ctx.warehouseASecond.id
        )?.priority
      ).toBe(2)
    })

    it('are never linked to a store of another organization, whatever the application does', async () => {
      // Store A with the warehouse of organization B, naming either organization
      await refused(
        owner.storeWarehouse.create({
          data: {
            organizationId: ctx.orgB.id,
            storeId: ctx.storeA.id,
            warehouseId: ctx.warehouseB.id,
            priority: 9
          }
        }),
        /foreign key/i
      )
      await refused(
        owner.storeWarehouse.create({
          data: {
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA.id,
            warehouseId: ctx.warehouseB.id,
            priority: 9
          }
        }),
        /foreign key/i
      )
      expect(
        await owner.storeWarehouse.count({
          where: { storeId: ctx.storeA.id, warehouseId: ctx.warehouseB.id }
        })
      ).toBe(0)
    })

    it('keep one link per store and warehouse, one warehouse per priority of a store, and a code per organization', async () => {
      const extra = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      await linkWarehouse(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        warehouseId: extra.id
      })

      await refused(
        linkWarehouse(owner, {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          warehouseId: extra.id
        }),
        /unique/i
      )
      const another = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      await refused(
        linkWarehouse(owner, {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          warehouseId: another.id,
          priority: 1
        }),
        /unique/i
      )
      await refused(
        createWarehouse(owner, { organizationId: ctx.orgA.id, code: extra.code }),
        /unique/i
      )
      // The same code in another organization is another warehouse
      await createWarehouse(owner, { organizationId: ctx.orgB.id, code: extra.code })
      await refused(
        owner.storeWarehouse.create({
          data: {
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA2.id,
            warehouseId: another.id,
            priority: 0
          }
        }),
        /chk_store_warehouses_priority/
      )
    })

    it('go with their organization, links included, and are not deleted while stock sits in them', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-gone`, slug: `${prefix}-gone` }
      })
      const store = await owner.store.create({
        data: { organizationId: org.id, name: 'gone', slug: 'gone' }
      })
      const warehouse = await createWarehouse(owner, { organizationId: org.id })
      await linkWarehouse(owner, {
        organizationId: org.id,
        storeId: store.id,
        warehouseId: warehouse.id
      })
      await owner.organization.delete({ where: { id: org.id } })
      expect(await owner.warehouse.count({ where: { organizationId: org.id } })).toBe(0)
      expect(await owner.storeWarehouse.count({ where: { organizationId: org.id } })).toBe(0)

      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id,
        onHand: 1
      })
      await refused(owner.warehouse.delete({ where: { id: ctx.warehouseA.id } }), /foreign key/i)
    })
  })

  describe('the stock of a product', () => {
    it('cannot name a product of another store, as a level or as a movement', async () => {
      const foreign = await createProduct(owner, { storeId: ctx.storeB.id })

      await refused(
        createInventoryLevel(owner, {
          storeId: ctx.storeA.id,
          productId: foreign.id,
          warehouseId: ctx.warehouseA.id
        }),
        /foreign key/i
      )
      await refused(
        createInventoryMovement(owner, {
          storeId: ctx.storeA.id,
          productId: foreign.id,
          warehouseId: ctx.warehouseA.id
        }),
        /foreign key/i
      )
    })

    it('has one level per item and warehouse, with or without a variant', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const variant = await createProductVariant(owner, { productId: product.id })
      const level = (variantId: string | null, warehouseId = ctx.warehouseA.id) =>
        createInventoryLevel(owner, {
          storeId: ctx.storeA.id,
          productId: product.id,
          variantId,
          warehouseId
        })

      await level(null)
      await refused(level(null), /uq_inventory_levels_product/)
      await level(variant.id)
      await refused(level(variant.id), /uq_inventory_levels_variant/)
      // Another warehouse is another level
      await level(null, ctx.warehouseASecond.id)
      await level(variant.id, ctx.warehouseASecond.id)
    })

    it('never has less than nothing reserved, and the ledger holds only whole, positive quantities and costs', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const input = {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id
      }

      await refused(
        createInventoryLevel(owner, { ...input, reserved: -1 }),
        /chk_inventory_reserved_non_negative/
      )
      // On hand may be negative: only a store that allows it gets there, and a service checks that
      await createInventoryLevel(owner, {
        ...input,
        warehouseId: ctx.warehouseASecond.id,
        onHand: -3
      })
      await refused(
        createInventoryMovement(owner, { ...input, quantity: 0 }),
        /chk_inventory_movements_quantity_positive/
      )
      await refused(
        createInventoryMovement(owner, { ...input, quantity: -2 }),
        /chk_inventory_movements_quantity_positive/
      )
      await refused(
        createInventoryMovement(owner, { ...input, unitCostCents: -1 }),
        /chk_inventory_movements_unit_cost/
      )
      await refused(
        createInventoryMovement(owner, { ...input, reservedAfter: -1 }),
        /chk_inventory_movements_reserved_after/
      )
      // A cost of zero and no cost at all are both real
      await createInventoryMovement(owner, { ...input, unitCostCents: 0 })
      await createInventoryMovement(owner, { ...input, unitCostCents: null })
    })

    it('applies a movement once: its idempotency key is unique across the platform', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const key = `${prefix}-${randomUUID()}`
      const input = {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id,
        idempotencyKey: key
      }

      await createInventoryMovement(owner, input)

      await refused(createInventoryMovement(owner, input), /unique/i)
    })

    it('keeps the product and its variants while stock refers to them', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const variant = await createProductVariant(owner, { productId: product.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        variantId: variant.id,
        warehouseId: ctx.warehouseA.id
      })

      await refused(owner.productVariant.delete({ where: { id: variant.id } }), /foreign key/i)
      await refused(owner.product.delete({ where: { id: product.id } }), /foreign key/i)
      // And a variant is never turned into the product itself by a delete (the level keeps its variant)
      expect(
        (await owner.inventoryLevel.findFirstOrThrow({ where: { productId: product.id } }))
          .variantId
      ).toBe(variant.id)
    })

    it('has an allocation only for a positive quantity, once per order line and warehouse', async () => {
      const customer = await owner.customer.create({
        data: { storeId: ctx.storeA.id, name: 'allocation' }
      })
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const order = await owner.order.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: customer.id,
          orderNumber: `${prefix}-${randomUUID().slice(0, 6)}`,
          subtotalCents: 100,
          totalCents: 100,
          paymentMethod: 'CASH_ON_DELIVERY',
          createdBy: ctx.adminA.id,
          items: {
            create: { productId: product.id, productName: 'p', quantity: 2, unitPriceCents: 50 }
          }
        },
        include: { items: true }
      })
      const orderItemId = order.items[0]?.id ?? ''
      const allocate = (quantity: number, warehouseId = ctx.warehouseA.id) =>
        owner.orderItemAllocation.create({
          data: { storeId: ctx.storeA.id, orderItemId, warehouseId, quantity }
        })

      await refused(allocate(0), /chk_order_item_allocations_quantity_positive/)
      await allocate(2)
      await refused(allocate(1), /unique/i)
      await allocate(1, ctx.warehouseASecond.id)
    })
  })

  describe('the ledger', () => {
    it('is append-only for the roles of the api and of the worker: they read and add, never change or remove', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const movement = await createInventoryMovement(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id,
        type: InventoryMovementType.RECEIPT,
        quantity: 5
      })
      for (const url of [connectionUrls().app, connectionUrls().worker]) {
        const asRole = createOwnerClient(url)
        try {
          expect(
            await asRole.inventoryMovement.findUnique({
              where: { id: movement.id },
              select: { quantity: true }
            })
          ).toEqual({ quantity: 5 })
          await refused(
            asRole.inventoryMovement.update({ where: { id: movement.id }, data: { quantity: 1 } }),
            /permission denied/i
          )
          await refused(
            asRole.inventoryMovement.delete({ where: { id: movement.id } }),
            /permission denied/i
          )
          await refused(
            asRole.inventoryMovement.deleteMany({ where: { storeId: ctx.storeA.id } }),
            /permission denied/i
          )
        } finally {
          await asRole.$disconnect()
        }
      }
      expect(
        (await owner.inventoryMovement.findUniqueOrThrow({ where: { id: movement.id } })).quantity
      ).toBe(5)
    })
  })

  describe('the store settings', () => {
    it('start with negative stock and split fulfillment off and no default threshold', async () => {
      const settings = await owner.storeSettings.findUniqueOrThrow({
        where: { storeId: ctx.storeA.id }
      })

      expect(settings).toMatchObject({
        allowNegativeStock: false,
        allowSplitFulfillment: false,
        defaultLowStockThreshold: null
      })
    })

    it('refuse a negative default threshold', async () => {
      await refused(
        owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { defaultLowStockThreshold: -1 }
        }),
        /chk_store_settings_default_low_stock/
      )
    })
  })

  describe('the bootstrap of a warehouse', () => {
    it('makes the default warehouse of an organization and links the store once, however many runs', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-boot`, slug: `${prefix}-boot` }
      })
      const store = await owner.store.create({
        data: { organizationId: org.id, name: 'boot', slug: 'boot' }
      })

      const first = await ensureDefaultWarehouse(owner, org.id, store.id)
      const second = await ensureDefaultWarehouse(owner, org.id, store.id)

      expect(second.id).toBe(first.id)
      expect(await owner.warehouse.count({ where: { organizationId: org.id } })).toBe(1)
      const links = await owner.storeWarehouse.findMany({ where: { storeId: store.id } })
      expect(links).toHaveLength(1)
      expect(links[0]?.priority).toBe(1)
    })

    it('puts the next warehouse of a store after the ones it has, and leaves an existing link alone', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-boot2`, slug: `${prefix}-boot2` }
      })
      const store = await owner.store.create({
        data: { organizationId: org.id, name: 'boot2', slug: 'boot2' }
      })
      const main = await ensureDefaultWarehouse(owner, org.id, store.id)
      const extra = await ensureWarehouse(owner, org.id, { code: 'EXTRA', name: 'Extra' })
      const ids = { organizationId: org.id, storeId: store.id, warehouseId: extra.id }

      await ensureStoreWarehouse(owner, ids)
      await ensureStoreWarehouse(owner, ids, 7)

      const links = await owner.storeWarehouse.findMany({
        where: { storeId: store.id },
        orderBy: { priority: 'asc' }
      })
      expect(links.map(link => [link.warehouseId, link.priority])).toEqual([
        [main.id, 1],
        [extra.id, 2]
      ])
    })
  })

  describe('the permission to see costs', () => {
    it('is held by the Admin preset and the Admin role of the database, and by no other role', async () => {
      expect(RolePresets[RoleNames.ADMIN]).toContain(Permissions.PRODUCTS_VIEW_COST)
      for (const role of [RoleNames.SUPERVISOR, RoleNames.AGENT, RoleNames.VIEWER]) {
        expect(RolePresets[role]).not.toContain(Permissions.PRODUCTS_VIEW_COST)
      }
      const holders = await owner.permission.findMany({
        where: { name: Permissions.PRODUCTS_VIEW_COST, role: { isSystem: true } },
        select: { role: { select: { name: true } } }
      })
      expect(holders.map(holder => holder.role.name)).toEqual([RoleNames.ADMIN])
    })
  })
})
