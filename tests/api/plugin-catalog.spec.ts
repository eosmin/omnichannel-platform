import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  InventoryAdjustmentReason,
  InventoryMovementType,
  TaxTreatment
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type PluginScope, PluginScopes } from '@platform/plugins/sdk'

import {
  createInventoryLevel,
  createInventoryMovement,
  createPluginKey,
  createProduct,
  createProductVariant,
  createTag
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
// the writes of a warehouse are not there. Step 5.6 PR E4a-2 adds the adjustment of stock (the plugin as the author of the
// movement), the general audit entries of the catalog and the tag catalog.
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
  let adjuster: { key: string; installationId: string; pluginId: string }
  let tagger: { key: string; installationId: string }
  let tagReader: { key: string; installationId: string }

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
    adjuster = {
      ...(await key(ctx.storeA.id, 'adjuster', [
        PluginScopes.INVENTORY_READ,
        PluginScopes.INVENTORY_WRITE
      ])),
      pluginId: `${prefix}-adjuster`
    }
    tagger = await key(ctx.storeA.id, 'tagger', [PluginScopes.TAGS_READ, PluginScopes.TAGS_WRITE])
    tagReader = await key(ctx.storeA.id, 'tagreader', [PluginScopes.TAGS_READ])
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

  describe('the adjustment of stock', () => {
    const adjustment = (productId: string, extra: object = {}) => ({
      warehouseId: ctx.warehouseA.id,
      productId,
      type: InventoryMovementType.RECEIPT,
      quantity: 5,
      reason: InventoryAdjustmentReason.OPENING_STOCK,
      idempotencyKey: randomUUID(),
      ...extra
    })

    it('records the plugin as the author of the movement and the installation in the audit log, never a user', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id, trackInventory: true })
      const body = adjustment(product.id)

      const made = await call('post', PluginApiRoutes.inventory.adjustments, adjuster.key)
        .send(body)
        .expect(CREATED)
      const retry = await call('post', PluginApiRoutes.inventory.adjustments, adjuster.key)
        .send(body)
        .expect(OK)

      const movement = (made.body as { movement: Row & { onHandAfter: number } }).movement
      expect(movement.onHandAfter).toBe(5)
      expect((retry.body as { movement: Row; replayed: boolean }).replayed).toBe(true)
      expect((retry.body as { movement: Row }).movement.id).toBe(movement.id)
      const row = await owner.inventoryMovement.findUniqueOrThrow({ where: { id: movement.id } })
      expect(row.createdBy).toBeNull()
      expect(row.createdByPluginId).toBe(adjuster.pluginId)
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(1)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.INVENTORY_ADJUSTED,
        resourceId: product.id
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({ pluginInstallationId: adjuster.installationId })
      // neither the plugin nor a person is named in what the plugin reads back
      expect(JSON.stringify(made.body)).not.toMatch(/createdBy/)
    })

    it('refuses to set the cost of the units: no scope grants products:view_cost', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id, trackInventory: true })

      const response = await call('post', PluginApiRoutes.inventory.adjustments, adjuster.key).send(
        adjustment(product.id, { unitCostCents: 100 })
      )

      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(0)
    })

    it('does not move the stock of a product or a warehouse of another store', async () => {
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id, trackInventory: true })
      const mine = await createProduct(owner, { storeId: ctx.storeA.id, trackInventory: true })

      const foreignProduct = await call(
        'post',
        PluginApiRoutes.inventory.adjustments,
        adjuster.key
      ).send(adjustment(theirs.id))
      const foreignWarehouse = await call(
        'post',
        PluginApiRoutes.inventory.adjustments,
        adjuster.key
      ).send(adjustment(mine.id, { warehouseId: ctx.warehouseB.id }))

      expect(foreignProduct.status).toBe(NOT_FOUND)
      expect(foreignWarehouse.status).toBe(NOT_FOUND)
      expect(
        await owner.inventoryMovement.count({ where: { productId: { in: [theirs.id, mine.id] } } })
      ).toBe(0)
    })

    it('needs both scopes: a key that reads or one that only writes is refused', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id, trackInventory: true })
      const writeOnlyKey = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${prefix}-adjustwriteonly`,
        scopes: [PluginScopes.INVENTORY_WRITE]
      })

      for (const key of [reader.key, writeOnlyKey.key]) {
        const response = await call('post', PluginApiRoutes.inventory.adjustments, key).send(
          adjustment(product.id)
        )
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
      expect(await owner.inventoryMovement.count({ where: { productId: product.id } })).toBe(0)
    })
  })

  describe('the audit of the catalog', () => {
    it('names the installation, and the fields it set but never their values, in a general entry', async () => {
      const created = await call('post', PluginApiRoutes.products.create, writer.key)
        .send({ name: `${prefix} secret name`, priceCents: 700 })
        .expect(CREATED)
      const productId = (created.body as Row).id
      await call('patch', PluginApiRoutes.products.byId(productId), writer.key)
        .send({ name: `${prefix} another secret`, active: false })
        .expect(OK)
      const variant = await call('post', PluginApiRoutes.products.variants(productId), writer.key)
        .send({ name: 'xl' })
        .expect(CREATED)

      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.PRODUCT_UPDATED, resourceId: productId },
        2
      )
      const [made] = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_CREATED,
        resourceId: productId
      })

      expect(made?.userId).toBeNull()
      expect(made?.metadata).toMatchObject({
        fields: ['name', 'priceCents'],
        pluginInstallationId: writer.installationId
      })
      const changed = entries.map(entry => entry.metadata)
      expect(changed).toContainEqual(
        expect.objectContaining({
          fields: ['active', 'name'],
          pluginInstallationId: writer.installationId
        })
      )
      expect(changed).toContainEqual(
        expect.objectContaining({
          variantId: (variant.body as Row).id,
          pluginInstallationId: writer.installationId
        })
      )
      for (const entry of [made, ...entries]) {
        expect(entry?.userId).toBeNull()
        expect(JSON.stringify(entry?.metadata)).not.toContain('secret')
      }
    })
  })

  describe('the tag catalog', () => {
    it('lists, creates, changes and deletes the tags of its own store, as the installation in the audit log', async () => {
      const mine = await createTag(owner, { storeId: ctx.storeA.id })
      const theirs = await createTag(owner, { storeId: ctx.storeB.id })

      const list = await call('get', PluginApiRoutes.settings.tags, tagReader.key).expect(OK)
      const created = await call('post', PluginApiRoutes.settings.tags, tagger.key)
        .send({ name: `${prefix}-vip` })
        .expect(CREATED)
      const tagId = (created.body as Row).id
      const renamed = await call('patch', PluginApiRoutes.settings.tagById(tagId), tagger.key)
        .send({ name: `${prefix}-vip2` })
        .expect(OK)
      await call('delete', PluginApiRoutes.settings.tagById(tagId), tagger.key).expect(NO_CONTENT)

      const names = (list.body as Row[]).map(tag => tag.id)
      expect(names).toContain(mine.id)
      expect(names).not.toContain(theirs.id)
      expect((renamed.body as { name: string }).name).toBe(`${prefix}-vip2`)
      expect(await owner.tag.count({ where: { id: tagId } })).toBe(0)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.SETTINGS_CHANGED,
        resourceId: tagId
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({ pluginInstallationId: tagger.installationId })
    })

    it('does not find, change or delete a tag of another store', async () => {
      const theirs = await createTag(owner, { storeId: ctx.storeB.id })

      const responses = [
        await call('get', PluginApiRoutes.settings.tagById(theirs.id), tagReader.key),
        await call('patch', PluginApiRoutes.settings.tagById(theirs.id), tagger.key).send({
          name: 'x'
        }),
        await call('delete', PluginApiRoutes.settings.tagById(theirs.id), tagger.key)
      ]

      for (const response of responses) expect(response.status).toBe(NOT_FOUND)
      expect((await owner.tag.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe(
        theirs.name
      )
    })

    it('writes only with the write scope, and a write scope alone does not read', async () => {
      const mine = await createTag(owner, { storeId: ctx.storeA.id })
      const writeOnlyKey = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${prefix}-tagwriteonly`,
        scopes: [PluginScopes.TAGS_WRITE]
      })

      const responses = [
        await call('post', PluginApiRoutes.settings.tags, tagReader.key).send({ name: 'x' }),
        await call('patch', PluginApiRoutes.settings.tagById(mine.id), tagReader.key).send({
          name: 'x'
        }),
        await call('delete', PluginApiRoutes.settings.tagById(mine.id), tagReader.key),
        await call('patch', PluginApiRoutes.settings.tagById(mine.id), writeOnlyKey.key).send({
          name: 'x'
        }),
        await call('get', PluginApiRoutes.settings.tags, reader.key)
      ]

      for (const response of responses) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
      expect((await owner.tag.findUniqueOrThrow({ where: { id: mine.id } })).name).toBe(mine.name)
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

    it('does not expose any write of a warehouse: they reach every store that shares it, and a key is bound to one', async () => {
      const requests = [
        call('post', '/plugin-api/warehouses', writer.key),
        call('patch', `/plugin-api/warehouses/${ctx.warehouseA.id}`, writer.key),
        call('put', `/plugin-api/warehouses/${ctx.warehouseA.id}/stores`, writer.key)
      ]

      for (const request of requests) {
        expect([NOT_FOUND, 405]).toContain((await request.send({})).status)
      }
      expect(
        (await owner.warehouse.findUniqueOrThrow({ where: { id: ctx.warehouseA.id } }))
          .organizationId
      ).toBe(ctx.orgA.id)
    })
  })
})
