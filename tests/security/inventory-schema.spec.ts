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
      // A code that reads the same in another case is the same code, and no code or name has stray spaces
      await refused(
        createWarehouse(owner, { organizationId: ctx.orgA.id, code: extra.code.toLowerCase() }),
        /uq_warehouses_code_lower/
      )
      await refused(
        createWarehouse(owner, { organizationId: ctx.orgA.id, code: ' PADDED' }),
        /chk_warehouses_code/
      )
      await refused(
        createWarehouse(owner, { organizationId: ctx.orgA.id, code: 'X'.repeat(21) }),
        /chk_warehouses_code/
      )
      await refused(
        createWarehouse(owner, { organizationId: ctx.orgA.id, name: '  ' }),
        /chk_warehouses_name/
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

    it('applies a movement once: its idempotency key is unique in its store, and a store never sees the keys of another', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const other = await createProduct(owner, { storeId: ctx.storeA2.id })
      const key = `${prefix}-${randomUUID()}`
      const input = {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id,
        idempotencyKey: key
      }

      await createInventoryMovement(owner, input)

      await refused(createInventoryMovement(owner, input), /unique/i)
      // The same key in another store is another movement: no tenant can block or read another's retries
      await createInventoryMovement(owner, {
        storeId: ctx.storeA2.id,
        productId: other.id,
        warehouseId: ctx.warehouseA.id,
        idempotencyKey: key
      })
    })

    it('cannot sit in a warehouse of another organization, whatever the store says', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const input = {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseB.id
      }

      await refused(createInventoryLevel(owner, input), /different organizations/)
      await refused(createInventoryMovement(owner, input), /different organizations/)
      // Moving a good row to the foreign warehouse is refused too
      const level = await createInventoryLevel(owner, { ...input, warehouseId: ctx.warehouseA.id })
      await refused(
        owner.inventoryLevel.update({
          where: { id: level.id },
          data: { warehouseId: ctx.warehouseB.id }
        }),
        /different organizations/
      )
      expect(await owner.inventoryLevel.count({ where: { warehouseId: ctx.warehouseB.id } })).toBe(
        0
      )
    })

    it('keeps its stock in a warehouse the store was unlinked from (a level is not a link)', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA2.id })
      const extra = await createWarehouse(owner, { organizationId: ctx.orgA.id })

      // Store A2 is not linked to it, but both are of organization A
      await createInventoryLevel(owner, {
        storeId: ctx.storeA2.id,
        productId: product.id,
        warehouseId: extra.id,
        onHand: 2
      })
    })

    it('cannot pair a product with the variant of another product', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const other = await createProduct(owner, { storeId: ctx.storeA.id })
      const foreignVariant = await createProductVariant(owner, { productId: other.id })
      const input = {
        storeId: ctx.storeA.id,
        productId: product.id,
        variantId: foreignVariant.id,
        warehouseId: ctx.warehouseA.id
      }

      await refused(createInventoryLevel(owner, input), /not a variant of its product/)
      await refused(createInventoryMovement(owner, input), /not a variant of its product/)
      await createInventoryLevel(owner, { ...input, productId: other.id })
    })

    it('cannot be deleted with the store or the warehouse that hold it', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-stocked`, slug: `${prefix}-stocked` }
      })
      const store = await owner.store.create({
        data: { organizationId: org.id, name: 'stocked', slug: 'stocked' }
      })
      const warehouse = await ensureDefaultWarehouse(owner, org.id, store.id)
      const product = await createProduct(owner, { storeId: store.id })
      await createInventoryMovement(owner, {
        storeId: store.id,
        productId: product.id,
        warehouseId: warehouse.id
      })

      await refused(owner.store.delete({ where: { id: store.id } }), /foreign key/i)
      await refused(owner.organization.delete({ where: { id: org.id } }), /foreign key/i)
      expect(await owner.inventoryMovement.count({ where: { storeId: store.id } })).toBe(1)
      // The owner of the database clears it by hand, as the suites do
      await owner.inventoryMovement.deleteMany({ where: { storeId: store.id } })
      await owner.product.deleteMany({ where: { storeId: store.id } })
      await owner.organization.delete({ where: { id: org.id } })
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

      // An allocation of another store naming this order line is refused
      await refused(
        owner.orderItemAllocation.create({
          data: {
            storeId: ctx.storeA2.id,
            orderItemId,
            warehouseId: ctx.warehouseA.id,
            quantity: 1
          }
        }),
        /order line of another store/
      )
      await refused(allocate(0), /chk_order_item_allocations_quantity_positive/)
      await allocate(2)
      await refused(allocate(1), /unique/i)
      await allocate(1, ctx.warehouseASecond.id)
    })
  })

  describe('the ledger', () => {
    it('gives no role of the application the privilege to change, remove or empty it, nor to anything else than read and add', async () => {
      const has = async (role: string, privilege: string): Promise<boolean> => {
        const rows = await owner.$queryRaw<{ allowed: boolean }[]>`
          SELECT has_table_privilege(${role}, 'inventory_movements', ${privilege}) AS allowed`
        return rows[0]?.allowed ?? true
      }
      for (const role of ['platform_app', 'platform_worker']) {
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
          expect({ role, privilege, allowed: await has(role, privilege) }).toEqual({
            role,
            privilege,
            allowed: false
          })
        }
        for (const privilege of ['SELECT', 'INSERT']) {
          expect({ role, privilege, allowed: await has(role, privilege) }).toEqual({
            role,
            privilege,
            allowed: true
          })
        }
      }
    })

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

    it('never undoes the owner: a renamed, recoded or unlinked warehouse does not come back as a twin', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-boot3`, slug: `${prefix}-boot3` }
      })
      const store = await owner.store.create({
        data: { organizationId: org.id, name: 'boot3', slug: 'boot3' }
      })
      const main = await ensureDefaultWarehouse(owner, org.id, store.id)
      await owner.warehouse.update({
        where: { id: main.id },
        data: { code: 'CENTRAL', name: 'Central' }
      })
      const extra = await ensureWarehouse(owner, org.id, { code: 'EXTRA', name: 'Extra' })
      await ensureStoreWarehouse(owner, {
        organizationId: org.id,
        storeId: store.id,
        warehouseId: extra.id
      })
      // The owner moves the store to EXTRA first
      await owner.storeWarehouse.deleteMany({ where: { storeId: store.id, warehouseId: main.id } })
      await owner.storeWarehouse.updateMany({
        where: { storeId: store.id },
        data: { priority: 1 }
      })

      await ensureDefaultWarehouse(owner, org.id, store.id)

      expect(await owner.warehouse.count({ where: { organizationId: org.id } })).toBe(2)
      const links = await owner.storeWarehouse.findMany({ where: { storeId: store.id } })
      expect(links.map(link => [link.warehouseId, link.priority])).toEqual([[extra.id, 1]])
    })

    it('links a store that has no link to the oldest warehouse of its organization, and a second store after it', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-boot2`, slug: `${prefix}-boot2` }
      })
      const first = await owner.store.create({
        data: { organizationId: org.id, name: 'boot2a', slug: 'boot2a' }
      })
      const second = await owner.store.create({
        data: { organizationId: org.id, name: 'boot2b', slug: 'boot2b' }
      })
      const main = await ensureDefaultWarehouse(owner, org.id, first.id)
      const extra = await ensureWarehouse(owner, org.id, { code: 'EXTRA', name: 'Extra' })
      const ids = { organizationId: org.id, storeId: first.id, warehouseId: extra.id }

      await ensureStoreWarehouse(owner, ids)
      await ensureStoreWarehouse(owner, ids, 7)
      const sibling = await ensureDefaultWarehouse(owner, org.id, second.id)

      expect(sibling.id).toBe(main.id)
      const links = await owner.storeWarehouse.findMany({
        where: { storeId: first.id },
        orderBy: { priority: 'asc' }
      })
      expect(links.map(link => [link.warehouseId, link.priority])).toEqual([
        [main.id, 1],
        [extra.id, 2]
      ])
      expect(
        (await owner.storeWarehouse.findMany({ where: { storeId: second.id } })).map(
          l => l.priority
        )
      ).toEqual([1])
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
