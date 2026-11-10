import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  InventoryMovementType,
  PaymentMethod,
  ProductConflicts,
  ProductHistoryTables,
  ProductLimits
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createCustomer, createProduct, createProductVariant } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface VariantBody {
  id: string
  productId: string
  name: string
  sku: string | null
  priceCents: number | null
  effectivePriceCents: number
  costCents: number | null
  attributes: Record<string, string>
  active: boolean
}
interface ProductBody {
  id: string
  name: string
  description: string | null
  priceCents: number
  costCents: number | null
  sku: string | null
  trackInventory: boolean
  lowStockThreshold: number | null
  active: boolean
  freeShipping: boolean
  variants: VariantBody[]
}
interface PageBody {
  data: (Omit<ProductBody, 'variants'> & { variantCount: number })[]
  nextCursor: string | null
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

describe('The products of a store', () => {
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
    // A product is held by its movements (no cascade): they go before the store does, even after a failed test
    await owner.inventoryMovement.deleteMany({
      where: { store: { organization: { slug: { startsWith: prefix } } } }
    })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const sku = (): string => `SKU-${randomUUID().slice(0, 8)}`
  // The audit is written after the answer: once the rows that must exist do, wait a beat for one that must not
  async function settledAudit(
    where: Parameters<typeof waitForAuditEntries>[1],
    expected: number
  ): ReturnType<typeof waitForAuditEntries> {
    await waitForAuditEntries(owner, where, expected)
    await new Promise(resolve => setTimeout(resolve, 400))
    return owner.auditLog.findMany({ where })
  }
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error

  async function create(body: Record<string, unknown>): Promise<ProductBody> {
    const response = await asAdmin()
      .post(ApiRoutes.products.create)
      .send({ name: `Product ${randomUUID().slice(0, 8)}`, priceCents: 1500, ...body })
    expect(response.status).toBe(CREATED)
    return response.body as ProductBody
  }
  async function addVariant(
    productId: string,
    body: Record<string, unknown>
  ): Promise<VariantBody> {
    const response = await asAdmin()
      .post(ApiRoutes.products.variants(productId))
      .send({ name: `Variant ${randomUUID().slice(0, 8)}`, ...body })
    expect(response.status).toBe(CREATED)
    return response.body as VariantBody
  }

  describe('creating a product', () => {
    it('stores it in the store of the request with the defaults of the catalog', async () => {
      const product = await create({ name: '  Running shoe  ', description: 'Light and fast' })

      expect(product).toMatchObject({
        name: 'Running shoe',
        description: 'Light and fast',
        priceCents: 1500,
        costCents: null,
        sku: null,
        trackInventory: true,
        // No threshold means no low-stock alert (TDD_16 §4.4)
        lowStockThreshold: null,
        active: true,
        freeShipping: false,
        variants: []
      })
      const row = await owner.product.findUniqueOrThrow({ where: { id: product.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
    })

    it('keeps what the caller sets: cost, sku, flags and a threshold, and a threshold of zero', async () => {
      const code = sku()
      const product = await create({
        costCents: 900,
        sku: code,
        trackInventory: false,
        lowStockThreshold: 0,
        freeShipping: true,
        active: false
      })

      expect(product).toMatchObject({
        costCents: 900,
        sku: code,
        trackInventory: false,
        lowStockThreshold: 0,
        freeShipping: true,
        active: false
      })
    })

    it('refuses a body that names the store, or anything else it does not know', async () => {
      const before = await owner.product.count({ where: { storeId: ctx.storeB.id } })
      const response = await asAdmin()
        .post(ApiRoutes.products.create)
        .send({ name: 'Smuggled', priceCents: 100, storeId: ctx.storeB.id })

      expect(response.status).toBe(BAD_REQUEST)
      expect(errorOf(response).code).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await owner.product.count({ where: { storeId: ctx.storeB.id } })).toBe(before)
    })

    it.each([
      ['no name', { name: undefined }],
      ['an empty name', { name: '   ' }],
      ['a name with a line break', { name: 'two\nlines' }],
      ['a name that is too long', { name: 'x'.repeat(ProductLimits.NAME_MAX_LENGTH + 1) }],
      ['a name with a NUL character', { name: 'nul\0' }],
      ['no price', { priceCents: undefined }],
      ['a price with cents of a cent', { priceCents: 10.5 }],
      ['a negative price', { priceCents: -1 }],
      ['a price as text', { priceCents: '1500' }],
      ['a price over the ceiling', { priceCents: ProductLimits.MAX_AMOUNT_CENTS + 1 }],
      ['a negative cost', { costCents: -5 }],
      ['a negative threshold', { lowStockThreshold: -1 }],
      ['a fractional threshold', { lowStockThreshold: 2.5 }],
      ['an empty sku', { sku: '  ' }],
      ['a sku that is too long', { sku: 's'.repeat(ProductLimits.SKU_MAX_LENGTH + 1) }],
      ['a flag that is not a boolean', { freeShipping: 'yes' }]
    ])('answers 400 for %s', async (_label, patch) => {
      const response = await asAdmin()
        .post(ApiRoutes.products.create)
        .send({ name: 'Valid', priceCents: 1500, ...patch })

      expect(response.status).toBe(BAD_REQUEST)
      expect(errorOf(response).code).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('answers 409 for a sku the store already uses, and accepts it in another store', async () => {
      const code = sku()
      await create({ sku: code })

      const again = await asAdmin()
        .post(ApiRoutes.products.create)
        .send({ name: 'Twin', priceCents: 100, sku: code })
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).code).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect(errorOf(again).metadata).toMatchObject({ conflict: ProductConflicts.SKU_IN_USE })

      const elsewhere = await api(app, ctx.adminA2, ctx.storeA2)
        .post(ApiRoutes.products.create)
        .send({ name: 'Elsewhere', priceCents: 100, sku: code })
      expect(elsewhere.status).toBe(CREATED)
    })

    it('answers one 201 and one 409 when the same sku arrives twice at once', async () => {
      const code = sku()
      const results = await Promise.all(
        [1, 2].map(n =>
          asAdmin()
            .post(ApiRoutes.products.create)
            .send({ name: `Race ${n}`, priceCents: 100, sku: code })
        )
      )

      expect(results.map(result => result.status).sort()).toEqual([CREATED, CONFLICT])
    })
  })

  describe('listing and reading', () => {
    it('lists the newest first in pages that never repeat a row, and only of the store', async () => {
      const listStore = ctx.storeA2
      const asOtherAdmin = () => api(app, ctx.adminA2, listStore)
      // Newer than anything else this store holds, so the pages start with these five
      const base = Date.now() + 3_600_000
      const made: string[] = []
      for (let index = 0; index < 5; index += 1) {
        made.push(
          (
            await createProduct(owner, {
              storeId: listStore.id,
              createdAt: new Date(base + index * 1000)
            })
          ).id
        )
      }
      await createProduct(owner, { storeId: ctx.storeB.id })

      const first = await asOtherAdmin().get(ApiRoutes.products.list).query({ limit: 2 })
      expect(first.status).toBe(OK)
      const firstPage = first.body as PageBody
      expect(firstPage.hasMore).toBe(true)
      expect(firstPage.nextCursor).not.toBeNull()
      expect(firstPage.data.map(item => item.id)).toEqual([made[4], made[3]])

      const second = await asOtherAdmin()
        .get(ApiRoutes.products.list)
        .query({ limit: 2, cursor: firstPage.nextCursor })
      const secondPage = second.body as PageBody
      expect(secondPage.data.map(item => item.id)).toEqual([made[2], made[1]])

      const seen = [...firstPage.data, ...secondPage.data].map(item => item.id)
      let cursor = secondPage.nextCursor
      let hasMore = secondPage.hasMore
      while (hasMore && cursor !== null) {
        const next = await asOtherAdmin().get(ApiRoutes.products.list).query({ limit: 2, cursor })
        const page = next.body as PageBody
        seen.push(...page.data.map(item => item.id))
        ;({ nextCursor: cursor, hasMore } = page)
      }
      // The last page says so, and no page repeated a row
      expect(cursor).toBeNull()
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen.slice(0, 5)).toEqual([made[4], made[3], made[2], made[1], made[0]])
    })

    it('filters by active and says how many variants each product has', async () => {
      const live = await create({ name: `Live ${randomUUID().slice(0, 6)}` })
      await addVariant(live.id, {})
      await addVariant(live.id, {})
      const archived = await create({ active: false })

      const all = await asAdmin().get(ApiRoutes.products.list).query({ limit: 100 })
      const items = (all.body as PageBody).data
      expect(items.find(item => item.id === live.id)?.variantCount).toBe(2)
      expect(items.some(item => item.id === archived.id)).toBe(true)

      const onlyActive = await asAdmin()
        .get(ApiRoutes.products.list)
        .query({ limit: 100, active: 'true' })
      const activeIds = (onlyActive.body as PageBody).data.map(item => item.id)
      expect(activeIds).toContain(live.id)
      expect(activeIds).not.toContain(archived.id)

      const onlyArchived = await asAdmin()
        .get(ApiRoutes.products.list)
        .query({ limit: 100, active: 'false' })
      const archivedIds = (onlyArchived.body as PageBody).data.map(item => item.id)
      expect(archivedIds).toContain(archived.id)
      expect(archivedIds).not.toContain(live.id)
    })

    it.each([
      ['a limit of zero', { limit: 0 }],
      ['a limit over the maximum', { limit: 101 }],
      ['a cursor that is not one', { cursor: 'nope' }],
      ['a parameter it does not know', { storeId: 'x' }],
      ['an active that is not a boolean', { active: 'maybe' }]
    ])('answers 400 for %s', async (_label, query) => {
      const response = await asAdmin().get(ApiRoutes.products.list).query(query)

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('shows a product with its variants, the cheapest rule being the price it inherits', async () => {
      const product = await create({ priceCents: 2000, costCents: 800 })
      const inherits = await addVariant(product.id, { name: 'Inherits' })
      const own = await addVariant(product.id, { name: 'Own', priceCents: 2500, costCents: 1000 })

      const response = await asAdmin().get(ApiRoutes.products.byId(product.id))

      expect(response.status).toBe(OK)
      const body = response.body as ProductBody
      expect(body.variants).toHaveLength(2)
      expect(body.variants.find(v => v.id === inherits.id)).toMatchObject({
        priceCents: null,
        effectivePriceCents: 2000,
        costCents: null,
        effectiveCostCents: 800
      })
      expect(body.variants.find(v => v.id === own.id)).toMatchObject({
        priceCents: 2500,
        effectivePriceCents: 2500,
        costCents: 1000
      })
    })

    it('answers 404 for a product that does not exist and 400 for an id that is not one', async () => {
      const missing = await asAdmin().get(ApiRoutes.products.byId(randomUUID()))
      expect(missing.status).toBe(NOT_FOUND)
      expect(errorOf(missing).code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)

      const malformed = await asAdmin().get(ApiRoutes.products.byId('not-a-uuid'))
      expect(malformed.status).toBe(BAD_REQUEST)
    })
  })

  describe('changing a product', () => {
    it('changes only the fields sent, and clears the threshold and the cost with null', async () => {
      const product = await create({ costCents: 500, lowStockThreshold: 4, description: 'Keep' })

      const response = await asAdmin()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ name: 'Renamed', costCents: null, lowStockThreshold: null, active: false })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        id: product.id,
        name: 'Renamed',
        description: 'Keep',
        priceCents: 1500,
        costCents: null,
        lowStockThreshold: null,
        active: false
      })
    })

    it('answers 400 for an empty change, a field it does not know and the store', async () => {
      const product = await create({})
      for (const body of [{}, { storeId: ctx.storeB.id }, { priceCents: -3 }, { name: '' }]) {
        const response = await asAdmin().patch(ApiRoutes.products.byId(product.id)).send(body)
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('answers 409 for a sku another product of the store holds, and lets a product keep its own', async () => {
      const code = sku()
      await create({ sku: code })
      const other = await create({ sku: sku() })

      const taken = await asAdmin().patch(ApiRoutes.products.byId(other.id)).send({ sku: code })
      expect(taken.status).toBe(CONFLICT)
      expect(errorOf(taken).metadata).toMatchObject({ conflict: ProductConflicts.SKU_IN_USE })

      const own = await asAdmin()
        .patch(ApiRoutes.products.byId(other.id))
        .send({ sku: other.sku, name: 'Same sku' })
      expect(own.status).toBe(OK)
    })

    it('records a change of price in the audit log with the old and the new value, and no other change', async () => {
      const product = await create({ priceCents: 1000 })

      await asAdmin().patch(ApiRoutes.products.byId(product.id)).send({ name: 'No price change' })
      await asAdmin()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ priceCents: 1000, description: 'Same price' })
      await asAdmin().patch(ApiRoutes.products.byId(product.id)).send({ priceCents: 1250 })

      const entries = await settledAudit(
        { action: AuditAction.PRODUCT_PRICE_CHANGED, resourceId: product.id },
        1
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ storeId: ctx.storeA.id, userId: ctx.adminA.id })
      expect(entries[0]?.metadata).toMatchObject({ fromCents: 1000, toCents: 1250 })
    })

    it('records a change of cost in the audit log with the old and the new value', async () => {
      const product = await create({ costCents: 500 })
      const variant = await addVariant(product.id, {})

      await asAdmin().patch(ApiRoutes.products.byId(product.id)).send({ costCents: 500 })
      await asAdmin().patch(ApiRoutes.products.byId(product.id)).send({ costCents: 450 })
      await asAdmin()
        .patch(ApiRoutes.products.variantById(product.id, variant.id))
        .send({ costCents: 300 })

      const entries = await settledAudit(
        { action: AuditAction.PRODUCT_COST_CHANGED, resourceId: { in: [product.id, variant.id] } },
        2
      )
      expect(entries).toHaveLength(2)
      expect(entries.find(entry => entry.resourceId === product.id)?.metadata).toMatchObject({
        fromCents: 500,
        toCents: 450
      })
      expect(entries.find(entry => entry.resourceId === variant.id)?.metadata).toMatchObject({
        fromCents: null,
        toCents: 300
      })
    })

    it('chains the audit of two price changes made at once: each one starts where the other ended', async () => {
      const product = await create({ priceCents: 1000 })

      const results = await Promise.all(
        [2000, 3000].map(priceCents =>
          asAdmin().patch(ApiRoutes.products.byId(product.id)).send({ priceCents })
        )
      )

      expect(results.map(result => result.status)).toEqual([OK, OK])
      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.PRODUCT_PRICE_CHANGED, resourceId: product.id },
        2
      )
      const steps = entries.map(entry => entry.metadata as { fromCents: number; toCents: number })
      const first = steps.find(step => step.fromCents === 1000)
      const second = steps.find(step => step.fromCents !== 1000)
      // Without the lock both would say they started at 1000
      expect(first).toBeDefined()
      expect(second?.fromCents).toBe(first?.toCents)
      const row = await owner.product.findUniqueOrThrow({ where: { id: product.id } })
      expect(row.priceCents).toBe(second?.toCents)
    })
  })

  describe('deleting a product', () => {
    it('removes a product that nothing refers to, with its variants, and records who did it', async () => {
      const product = await create({})
      const variant = await addVariant(product.id, {})

      const response = await asAdmin().delete(ApiRoutes.products.byId(product.id))

      expect(response.status).toBe(NO_CONTENT)
      expect(await owner.product.findUnique({ where: { id: product.id } })).toBeNull()
      expect(await owner.productVariant.findUnique({ where: { id: variant.id } })).toBeNull()
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_DELETED,
        resourceId: product.id
      })
      expect(entries[0]).toMatchObject({ storeId: ctx.storeA.id, userId: ctx.adminA.id })
      // The row is gone: the entry says what it was
      expect(entries[0]?.metadata).toMatchObject({
        name: product.name,
        sku: null,
        priceCents: 1500,
        costCents: null
      })
      expect((await asAdmin().get(ApiRoutes.products.byId(product.id))).status).toBe(NOT_FOUND)
    })

    it('answers 409 for a product that an order names and keeps it, to be archived instead', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.order.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: customer.id,
          orderNumber: `${prefix}-${randomUUID().slice(0, 6)}`,
          subtotalCents: 1999,
          totalCents: 1999,
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
          createdBy: ctx.adminA.id,
          items: {
            create: {
              productId: product.id,
              productName: product.name,
              quantity: 1,
              unitPriceCents: 1999
            }
          }
        }
      })

      const response = await asAdmin().delete(ApiRoutes.products.byId(product.id))

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({
        conflict: ProductConflicts.HAS_HISTORY,
        [ProductHistoryTables.ORDER_ITEMS]: 1
      })
      expect(await owner.product.findUnique({ where: { id: product.id } })).not.toBeNull()
      const archive = await asAdmin()
        .patch(ApiRoutes.products.byId(product.id))
        .send({ active: false })
      expect(archive.status).toBe(OK)
    })

    it('answers 409 for a product that has files, so that they are not orphaned', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const file = await owner.media.create({
        data: {
          storeId: ctx.storeA.id,
          productId: product.id,
          purpose: 'product',
          filename: 'photo.png',
          contentType: 'image/png',
          fileSize: 10,
          key: `${prefix}/${randomUUID()}`
        },
        select: { id: true }
      })
      expect(file.id).toBeDefined()

      const response = await asAdmin().delete(ApiRoutes.products.byId(product.id))

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({
        conflict: ProductConflicts.HAS_HISTORY,
        [ProductHistoryTables.MEDIA]: 1
      })
      expect(await owner.product.findUnique({ where: { id: product.id } })).not.toBeNull()
    })

    it('answers 409 for a product with stock movements', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const movement = await owner.inventoryMovement.create({
        data: {
          storeId: ctx.storeA.id,
          productId: product.id,
          type: InventoryMovementType.RECEIPT,
          quantity: 3
        },
        select: { id: true }
      })
      expect(movement.id).toBeDefined()

      const response = await asAdmin().delete(ApiRoutes.products.byId(product.id))

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({
        conflict: ProductConflicts.HAS_HISTORY,
        [ProductHistoryTables.INVENTORY_MOVEMENTS]: 1
      })
    })
  })

  describe('the variants of a product', () => {
    it('creates one that inherits the price, and one with its own, with attributes', async () => {
      const product = await create({ priceCents: 3000 })

      const plain = await addVariant(product.id, { name: 'Size 42' })
      const full = await addVariant(product.id, {
        name: 'Red / L',
        sku: sku(),
        priceCents: 3500,
        costCents: 1200,
        attributes: { color: 'red', size: 'L' }
      })

      expect(plain).toMatchObject({
        productId: product.id,
        priceCents: null,
        effectivePriceCents: 3000,
        costCents: null,
        attributes: {},
        active: true
      })
      expect(full).toMatchObject({
        priceCents: 3500,
        effectivePriceCents: 3500,
        costCents: 1200,
        attributes: { color: 'red', size: 'L' }
      })
    })

    it.each([
      ['no name', { name: undefined }],
      ['a negative price', { priceCents: -1 }],
      ['a price over the ceiling', { priceCents: ProductLimits.MAX_AMOUNT_CENTS + 1 }],
      ['attributes that are not text', { attributes: { size: 42 } }],
      ['attributes that are a list', { attributes: ['x'] }],
      [
        'too many attributes',
        {
          attributes: Object.fromEntries(
            Array.from({ length: ProductLimits.MAX_ATTRIBUTES + 1 }, (_, i) => [`k${i}`, 'v'])
          )
        }
      ],
      [
        'an attribute value that is too long',
        {
          attributes: { size: 'v'.repeat(ProductLimits.ATTRIBUTE_VALUE_MAX_LENGTH + 1) }
        }
      ],
      ['a field it does not know', { productId: randomUUID() }]
    ])('answers 400 for %s', async (_label, patch) => {
      const product = await create({})

      const response = await asAdmin()
        .post(ApiRoutes.products.variants(product.id))
        .send({ name: 'Valid', ...patch })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('answers 409 for a name its product already has, and for a sku the store already uses', async () => {
      const product = await create({ sku: sku() })
      const other = await create({})
      const code = sku()
      await addVariant(product.id, { name: 'Taken', sku: code })

      const sameName = await asAdmin()
        .post(ApiRoutes.products.variants(product.id))
        .send({ name: 'Taken' })
      expect(sameName.status).toBe(CONFLICT)
      expect(errorOf(sameName).metadata).toMatchObject({
        conflict: ProductConflicts.VARIANT_NAME_IN_USE
      })
      // The same name in another product is a different variant
      await addVariant(other.id, { name: 'Taken' })

      const sameSkuElsewhere = await asAdmin()
        .post(ApiRoutes.products.variants(other.id))
        .send({ name: 'Another', sku: code })
      expect(sameSkuElsewhere.status).toBe(CONFLICT)
      expect(errorOf(sameSkuElsewhere).metadata).toMatchObject({
        conflict: ProductConflicts.SKU_IN_USE
      })
    })

    it('lets only one of two variants that bring the same sku at once, in different products, in', async () => {
      const [one, two] = await Promise.all([create({}), create({})])
      const code = sku()

      const results = await Promise.all(
        [one, two].map(product =>
          asAdmin().post(ApiRoutes.products.variants(product.id)).send({ name: 'Race', sku: code })
        )
      )

      expect(results.map(result => result.status).sort()).toEqual([CREATED, CONFLICT])
    })

    it('stops at the limit of variants a product may have', async () => {
      const product = await create({})
      await owner.productVariant.createMany({
        data: Array.from({ length: ProductLimits.MAX_VARIANTS_PER_PRODUCT }, (_, index) => ({
          productId: product.id,
          name: `bulk-${index}`,
          attributes: {}
        }))
      })

      const response = await asAdmin()
        .post(ApiRoutes.products.variants(product.id))
        .send({ name: 'One too many' })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({
        conflict: ProductConflicts.TOO_MANY_VARIANTS
      })
    })

    it('changes a variant, gives its price back to the product with null, and audits a price change', async () => {
      const product = await create({ priceCents: 1000 })
      const variant = await addVariant(product.id, { priceCents: 1200 })

      const changed = await asAdmin()
        .patch(ApiRoutes.products.variantById(product.id, variant.id))
        .send({ priceCents: null, active: false, attributes: { size: 'M' } })

      expect(changed.status).toBe(OK)
      expect(changed.body).toMatchObject({
        priceCents: null,
        effectivePriceCents: 1000,
        active: false,
        attributes: { size: 'M' }
      })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_PRICE_CHANGED,
        resourceId: variant.id
      })
      expect(entries[0]?.metadata).toMatchObject({ fromCents: 1200, toCents: null })
    })

    it('reaches a variant only through its own product', async () => {
      const product = await create({})
      const other = await create({})
      const variant = await addVariant(product.id, { name: 'Mine' })

      const wrongParent = await asAdmin()
        .patch(ApiRoutes.products.variantById(other.id, variant.id))
        .send({ name: 'Hijacked' })
      expect(wrongParent.status).toBe(NOT_FOUND)
      const wrongParentDelete = await asAdmin().delete(
        ApiRoutes.products.variantById(other.id, variant.id)
      )
      expect(wrongParentDelete.status).toBe(NOT_FOUND)
      expect(
        (await owner.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).name
      ).toBe('Mine')
    })

    it('deletes a variant, and refuses (409) one that an order names', async () => {
      const product = await create({})
      const free = await addVariant(product.id, { name: 'Free' })
      const used = await addVariant(product.id, { name: 'Used' })
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.order.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: customer.id,
          orderNumber: `${prefix}-${randomUUID().slice(0, 6)}`,
          subtotalCents: 1500,
          totalCents: 1500,
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
          createdBy: ctx.adminA.id,
          items: {
            create: {
              productId: product.id,
              variantId: used.id,
              productName: 'p',
              quantity: 1,
              unitPriceCents: 1500
            }
          }
        }
      })

      const removed = await asAdmin().delete(ApiRoutes.products.variantById(product.id, free.id))
      expect(removed.status).toBe(NO_CONTENT)
      expect(await owner.productVariant.findUnique({ where: { id: free.id } })).toBeNull()
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.PRODUCT_VARIANT_DELETED,
        resourceId: free.id
      })
      expect(entries).toHaveLength(1)

      const refused = await asAdmin().delete(ApiRoutes.products.variantById(product.id, used.id))
      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).metadata).toMatchObject({ conflict: ProductConflicts.HAS_HISTORY })
    })
  })

  describe('permissions', () => {
    it('lets a member who may only view read and nothing else', async () => {
      const product = await create({})
      const variant = await addVariant(product.id, {})
      const viewer = api(app, ctx.viewerA, ctx.storeA)

      expect((await viewer.get(ApiRoutes.products.list)).status).toBe(OK)
      expect((await viewer.get(ApiRoutes.products.byId(product.id))).status).toBe(OK)
      const attempts = [
        viewer.post(ApiRoutes.products.create).send({ name: 'x', priceCents: 1 }),
        viewer.patch(ApiRoutes.products.byId(product.id)).send({ name: 'x' }),
        viewer.delete(ApiRoutes.products.byId(product.id)),
        viewer.post(ApiRoutes.products.variants(product.id)).send({ name: 'x' }),
        viewer.patch(ApiRoutes.products.variantById(product.id, variant.id)).send({ name: 'x' }),
        viewer.delete(ApiRoutes.products.variantById(product.id, variant.id))
      ]
      for (const attempt of attempts) {
        const response = await attempt
        expect(response.status).toBe(FORBIDDEN)
        expect(errorOf(response).code).toBe(ErrorCodes.PERMISSION_DENIED)
      }
      expect(await owner.product.findUnique({ where: { id: product.id } })).not.toBeNull()
    })

    it('asks for one permission per action, and not for the one next to it', async () => {
      const product = await create({})
      const variant = await addVariant(product.id, {})
      const member = async (
        name: string,
        permission: (typeof Permissions)[keyof typeof Permissions]
      ) =>
        api(
          app,
          await actorWithPermissions(owner, app, {
            prefix,
            name,
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA.id,
            permissions: [permission]
          }),
          ctx.storeA
        )
      const creator = await member('products-creator', Permissions.PRODUCTS_CREATE)
      const editor = await member('products-editor', Permissions.PRODUCTS_EDIT)
      const deleter = await member('products-deleter', Permissions.PRODUCTS_DELETE)

      // Creating a product or a variant needs create; editing either needs edit; deleting needs delete
      expect(
        (await creator.post(ApiRoutes.products.create).send({ name: 'c', priceCents: 1 })).status
      ).toBe(CREATED)
      expect(
        (await creator.post(ApiRoutes.products.variants(product.id)).send({ name: 'cv' })).status
      ).toBe(CREATED)
      expect(
        (await creator.patch(ApiRoutes.products.byId(product.id)).send({ name: 'n' })).status
      ).toBe(FORBIDDEN)
      expect(
        (await editor.patch(ApiRoutes.products.byId(product.id)).send({ name: 'edited' })).status
      ).toBe(OK)
      expect(
        (
          await editor
            .patch(ApiRoutes.products.variantById(product.id, variant.id))
            .send({ name: 'edited' })
        ).status
      ).toBe(OK)
      expect(
        (await editor.post(ApiRoutes.products.create).send({ name: 'e', priceCents: 1 })).status
      ).toBe(FORBIDDEN)
      expect(
        (await editor.delete(ApiRoutes.products.variantById(product.id, variant.id))).status
      ).toBe(FORBIDDEN)
      // Reading is view and only view
      expect((await creator.get(ApiRoutes.products.byId(product.id))).status).toBe(FORBIDDEN)
      expect((await deleter.get(ApiRoutes.products.list)).status).toBe(FORBIDDEN)
      expect(
        (await deleter.delete(ApiRoutes.products.variantById(product.id, variant.id))).status
      ).toBe(NO_CONTENT)
      expect((await deleter.delete(ApiRoutes.products.byId(product.id))).status).toBe(NO_CONTENT)
    })
  })

  describe('the other stores', () => {
    it('does not show, change or delete the product of another store, and does not take its variant', async () => {
      const foreign = await createProduct(owner, { storeId: ctx.storeB.id })
      const foreignVariant = await createProductVariant(owner, { productId: foreign.id })

      const attempts = [
        asAdmin().get(ApiRoutes.products.byId(foreign.id)),
        asAdmin().patch(ApiRoutes.products.byId(foreign.id)).send({ name: 'hacked' }),
        asAdmin().delete(ApiRoutes.products.byId(foreign.id)),
        asAdmin().post(ApiRoutes.products.variants(foreign.id)).send({ name: 'planted' }),
        asAdmin()
          .patch(ApiRoutes.products.variantById(foreign.id, foreignVariant.id))
          .send({ name: 'hacked' }),
        asAdmin().delete(ApiRoutes.products.variantById(foreign.id, foreignVariant.id))
      ]
      for (const attempt of attempts) {
        const response = await attempt
        expect(response.status).toBe(NOT_FOUND)
        expect(errorOf(response).code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      }
      expect((await owner.product.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(
        foreign.name
      )
      expect(await owner.productVariant.count({ where: { productId: foreign.id } })).toBe(1)
      const listed = await asAdmin().get(ApiRoutes.products.list).query({ limit: 100 })
      expect((listed.body as PageBody).data.map(item => item.id)).not.toContain(foreign.id)
    })

    it('does not let a sibling store of the same organization in either', async () => {
      const mine = await create({})

      const response = await api(app, ctx.adminA2, ctx.storeA2).get(
        ApiRoutes.products.byId(mine.id)
      )

      expect(response.status).toBe(NOT_FOUND)
    })
  })
})
