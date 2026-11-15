import { randomInt } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import { TaxTreatment } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type PluginScope, PluginScopes } from '@platform/plugins/sdk'

import {
  createInventoryLevel,
  createInventoryMovement,
  createPluginKey,
  createProduct,
  createProductVariant
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const FORBIDDEN = 403
const NOT_FOUND = 404

interface ErrorBody {
  error: { code: string }
}
interface Row {
  id: string
}
interface PageBody {
  data: Row[]
}
interface WarehouseBody {
  id: string
  stores: { storeId: string }[]
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

// TDD_10 §6, Step 5.6 PR E4a: the catalog, the stock and the warehouses under the key of a plugin, over the same services as the
// screens. What matters is the tenancy (the key names the store, and the organization for the warehouses), the scopes (each route
// its own), what a plugin must never read or write (cost, tax, the person behind a movement, the links to other stores) and that
// the adjustment of stock and the store links are not there.
describe('Catalog, stock and warehouses through the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let reader: { key: string; installationId: string }
  let writer: { key: string; installationId: string }
  let readerB: { key: string; installationId: string }
  let writeOnly: { key: string; installationId: string }
  let readOnly: { key: string; installationId: string }
  let deleter: { key: string; installationId: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const key = (storeId: string, name: string, scopes: PluginScope[]) =>
      createPluginKey(owner, { storeId, pluginId: `${prefix}-${name}`, scopes })
    reader = await key(ctx.storeA.id, 'reader', [
      PluginScopes.PRODUCTS_READ,
      PluginScopes.INVENTORY_READ,
      PluginScopes.WAREHOUSES_READ
    ])
    readerB = await key(ctx.storeB.id, 'readerb', [
      PluginScopes.PRODUCTS_READ,
      PluginScopes.INVENTORY_READ,
      PluginScopes.WAREHOUSES_READ
    ])
    writer = await key(ctx.storeA.id, 'writer', [
      PluginScopes.PRODUCTS_READ,
      PluginScopes.PRODUCTS_WRITE,
      PluginScopes.WAREHOUSES_READ
    ])
    writeOnly = await key(ctx.storeA.id, 'writeonly', [PluginScopes.PRODUCTS_WRITE])
    readOnly = await key(ctx.storeA.id, 'readonly', [
      PluginScopes.PRODUCTS_READ,
      PluginScopes.WAREHOUSES_READ
    ])
    deleter = await key(ctx.storeA.id, 'deleter', [
      PluginScopes.PRODUCTS_READ,
      PluginScopes.PRODUCTS_DELETE
    ])
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const call = (method: Method, path: string, key?: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    const request = supertest(server)
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const ids = (body: unknown) => (body as PageBody).data.map(row => row.id)

  describe('the tenancy', () => {
    it('lists the products of the store of the key only, and ignores x-store-id', async () => {
      const mine = await createProduct(owner, { storeId: ctx.storeA.id })
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id })

      const a = await call('get', PluginApiRoutes.products.list, reader.key)
        .set('x-store-id', ctx.storeB.id)
        .expect(OK)
      const b = await call('get', PluginApiRoutes.products.list, readerB.key).expect(OK)

      expect(ids(a.body)).toContain(mine.id)
      expect(ids(a.body)).not.toContain(theirs.id)
      expect(ids(b.body)).toContain(theirs.id)
      expect(ids(b.body)).not.toContain(mine.id)
    })

    it('does not find, change or delete a product of another store, nor its variants, pictures or stock', async () => {
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id })
      const variant = await createProductVariant(owner, { productId: theirs.id })
      const reads = [
        call('get', PluginApiRoutes.products.byId(theirs.id), writer.key),
        call('get', PluginApiRoutes.products.images(theirs.id), writer.key),
        call('get', PluginApiRoutes.products.inventory(theirs.id), reader.key)
      ]
      const writes = [
        call('patch', PluginApiRoutes.products.byId(theirs.id), writer.key).send({ name: 'x' }),
        call('delete', PluginApiRoutes.products.byId(theirs.id), deleter.key),
        call('post', PluginApiRoutes.products.variants(theirs.id), writer.key).send({
          name: 'v'
        }),
        call('patch', PluginApiRoutes.products.variantById(theirs.id, variant.id), writer.key).send(
          { name: 'x' }
        )
      ]

      for (const request of [...reads, ...writes]) {
        const response = await request
        expect(response.status).toBe(NOT_FOUND)
      }
      expect(await owner.product.count({ where: { id: theirs.id } })).toBe(1)
      expect((await owner.product.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe(
        theirs.name
      )
    })

    it('reads the stock of its own store only', async () => {
      const mine = await createProduct(owner, { storeId: ctx.storeA.id })
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: mine.id,
        warehouseId: ctx.warehouseA.id,
        onHand: 5
      })
      await createInventoryLevel(owner, {
        storeId: ctx.storeB.id,
        productId: theirs.id,
        warehouseId: ctx.warehouseB.id,
        onHand: 9
      })

      const levels = await call('get', PluginApiRoutes.inventory.levels, reader.key).expect(OK)
      const summary = await call('get', PluginApiRoutes.inventory.summary, reader.key)
        .query({ productIds: `${mine.id},${theirs.id}` })
        .expect(OK)

      const text = JSON.stringify(levels.body)
      expect(text).toContain(mine.id)
      expect(text).not.toContain(theirs.id)
      expect(JSON.stringify(summary.body)).not.toContain(theirs.id)
    })

    it('reads the warehouses of its organization and never those of another one', async () => {
      const list = await call('get', PluginApiRoutes.warehouses.list, reader.key).expect(OK)

      expect(ids(list.body)).toContain(ctx.warehouseA.id)
      expect(ids(list.body)).not.toContain(ctx.warehouseB.id)
      await call('get', PluginApiRoutes.warehouses.byId(ctx.warehouseB.id), reader.key).expect(
        NOT_FOUND
      )
    })

    it('does not show the links of a warehouse to the other stores of the organization', async () => {
      // Warehouse A serves store A and its sibling store A2
      const response = await call(
        'get',
        PluginApiRoutes.warehouses.byId(ctx.warehouseA.id),
        reader.key
      ).expect(OK)

      const body = response.body as WarehouseBody
      expect(body.stores.map(link => link.storeId)).toEqual([ctx.storeA.id])
      expect(JSON.stringify(response.body)).not.toContain(ctx.storeA2.id)
      const list = await call('get', PluginApiRoutes.warehouses.list, reader.key).expect(OK)
      expect(JSON.stringify(list.body)).not.toContain(ctx.storeA2.id)
    })
  })

  describe('what a plugin reads', () => {
    it('never reads the cost of a product, a variant or a unit of stock', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await owner.product.update({ where: { id: product.id }, data: { costCents: 777 } })
      const variant = await createProductVariant(owner, { productId: product.id })
      await owner.productVariant.update({ where: { id: variant.id }, data: { costCents: 888 } })
      await createInventoryLevel(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id,
        onHand: 4
      })
      await createInventoryMovement(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id,
        quantity: 4,
        unitCostCents: 999
      })

      const responses = await Promise.all([
        call('get', PluginApiRoutes.products.list, reader.key),
        call('get', PluginApiRoutes.products.byId(product.id), reader.key),
        call('get', PluginApiRoutes.products.inventory(product.id), reader.key),
        call('get', PluginApiRoutes.inventory.levels, reader.key),
        call('get', PluginApiRoutes.inventory.movements, reader.key),
        call('get', PluginApiRoutes.inventory.kardex, reader.key).query({
          productId: product.id,
          warehouseId: ctx.warehouseA.id
        })
      ])

      for (const response of responses) {
        expect(response.status).toBe(OK)
        const text = JSON.stringify(response.body)
        expect(text).not.toMatch(/:(777|888|999)[,}]/)
        expect(text.toLowerCase()).not.toMatch(/costcents|valuecents|averagecost/)
      }
    })

    it('answers a stock movement without the person who made it', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const member = await owner.membership.findFirstOrThrow({
        where: { storeId: ctx.storeA.id },
        select: { userId: true }
      })
      const movement = await createInventoryMovement(owner, {
        storeId: ctx.storeA.id,
        productId: product.id,
        warehouseId: ctx.warehouseA.id
      })
      await owner.inventoryMovement.update({
        where: { id: movement.id },
        data: { createdBy: member.userId }
      })

      const movements = await call('get', PluginApiRoutes.inventory.movements, reader.key).expect(
        OK
      )
      const kardex = await call('get', PluginApiRoutes.inventory.kardex, reader.key)
        .query({ productId: product.id, warehouseId: ctx.warehouseA.id })
        .expect(OK)

      expect(ids(movements.body)).toContain(movement.id)
      expect(ids(kardex.body)).toContain(movement.id)
      for (const response of [movements, kardex]) {
        expect(JSON.stringify(response.body)).not.toContain(member.userId)
        expect(JSON.stringify(response.body)).not.toContain('createdBy')
      }
    })
  })

  describe('the writes of the catalog', () => {
    it('creates, changes and deletes a product and a variant, leaving the system as the actor in the audit log', async () => {
      const created = await call('post', PluginApiRoutes.products.create, writer.key)
        .send({ name: `${prefix} lamp`, priceCents: 1500 })
        .expect(CREATED)
      const productId = (created.body as Row).id
      const variant = await call('post', PluginApiRoutes.products.variants(productId), writer.key)
        .send({ name: 'blue' })
        .expect(CREATED)
      const variantId = (variant.body as Row).id

      const updated = await call('patch', PluginApiRoutes.products.byId(productId), writer.key)
        .send({ priceCents: 1800 })
        .expect(OK)
      await call('patch', PluginApiRoutes.products.variantById(productId, variantId), writer.key)
        .send({ priceCents: 1900 })
        .expect(OK)

      expect((updated.body as { priceCents: number }).priceCents).toBe(1800)
      expect(JSON.stringify(created.body)).not.toMatch(/costCents/)
      const row = await owner.product.findUniqueOrThrow({ where: { id: productId } })
      expect(row.storeId).toBe(ctx.storeA.id)
      const [price] = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_PRICE_CHANGED,
        resourceId: productId
      })
      expect(price?.userId).toBeNull()
      expect(price?.metadata).toMatchObject({ pluginInstallationId: writer.installationId })
      const [variantPrice] = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_PRICE_CHANGED,
        resourceId: variantId
      })
      expect(variantPrice?.userId).toBeNull()
      expect(variantPrice?.metadata).toMatchObject({ pluginInstallationId: writer.installationId })
    })

    it('refuses to set a cost or a tax: no scope grants those permissions', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })

      const withCost = await call('post', PluginApiRoutes.products.create, writer.key).send({
        name: `${prefix} costed`,
        priceCents: 100,
        costCents: 50
      })
      const costChange = await call(
        'patch',
        PluginApiRoutes.products.byId(product.id),
        writer.key
      ).send({ costCents: null })
      const withTax = await call(
        'patch',
        PluginApiRoutes.products.byId(product.id),
        writer.key
      ).send({ taxTreatment: TaxTreatment.EXEMPT })

      for (const response of [withCost, costChange, withTax]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      }
      expect(
        (await owner.product.findUniqueOrThrow({ where: { id: product.id } })).costCents
      ).toBeNull()
    })

    it('deletes only with the scope of its own, as the system in the audit log', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })

      const refused = await call('delete', PluginApiRoutes.products.byId(product.id), writer.key)
      await call('delete', PluginApiRoutes.products.byId(product.id), deleter.key).expect(
        NO_CONTENT
      )

      expect(refused.status).toBe(FORBIDDEN)
      expect(codeOf(refused.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_DELETED,
        resourceId: product.id
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({ pluginInstallationId: deleter.installationId })
      const refusedVariant = await call(
        'delete',
        PluginApiRoutes.products.variantById(product.id, product.id),
        writer.key
      )
      expect(refusedVariant.status).toBe(FORBIDDEN)
    })
  })

  describe('the scopes', () => {
    it('refuses a call with no key', async () => {
      await call('get', PluginApiRoutes.products.list).expect(401)
    })

    it('refuses each route to a key that does not hold its scope', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const denied = [
        call('get', PluginApiRoutes.inventory.levels, readOnly.key),
        call('get', PluginApiRoutes.inventory.movements, readOnly.key),
        call('get', PluginApiRoutes.products.inventory(product.id), readOnly.key),
        call('get', PluginApiRoutes.products.list, writeOnly.key),
        call('get', PluginApiRoutes.warehouses.list, writeOnly.key),
        call('post', PluginApiRoutes.products.create, readOnly.key).send({
          name: 'x',
          priceCents: 1
        }),
        call('patch', PluginApiRoutes.products.byId(product.id), readOnly.key).send({ name: 'x' }),
        // a write without the read scope does not tell whether a product exists
        call('patch', PluginApiRoutes.products.byId(product.id), writeOnly.key).send({ name: 'x' })
      ]

      for (const request of denied) {
        const response = await request
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
      expect((await owner.product.findUniqueOrThrow({ where: { id: product.id } })).name).toBe(
        product.name
      )
    })

    it('does not expose the adjustment of stock nor any write of a warehouse: the first stores a person, the others reach the whole organization', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const requests = [
        call('post', '/plugin-api/inventory/adjustments', writer.key),
        call('post', '/plugin-api/warehouses', writer.key),
        call('patch', `/plugin-api/warehouses/${ctx.warehouseA.id}`, writer.key),
        call('put', `/plugin-api/warehouses/${ctx.warehouseA.id}/stores`, writer.key)
      ]

      for (const request of requests) {
        expect([NOT_FOUND, 405]).toContain((await request.send({})).status)
      }
      expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(0)
      expect(
        (await owner.warehouse.findUniqueOrThrow({ where: { id: ctx.warehouseA.id } }))
          .organizationId
      ).toBe(ctx.orgA.id)
    })
  })
})
