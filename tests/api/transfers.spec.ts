import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import { ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  InventoryAdjustmentReason,
  InventoryConflicts,
  ProductConflicts,
  ProductHistoryTables,
  InventoryMovementType as Type,
  TransferShortageAction,
  TransferStatus,
  WarehouseStockBlocks
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { InventoryService } from '@platform/core/inventory'
import { NotificationTypes } from '@platform/core/notifications'

import { createProduct, createProductVariant, createWarehouse, linkWarehouse } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface LineBody {
  id: string
  storeId: string
  productId: string
  quantity: number
  receivedQuantity: number
  pendingQuantity: number
  shortageAction: string | null
}
interface TransferBody {
  id: string
  number: string
  status: string
  lines: LineBody[]
}
interface PageBody {
  data: { id: string; number: string; lineCount: number }[]
  nextCursor: string | null
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

describe('Transfers between warehouses', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inventory: InventoryService
  // A warehouse that stores A and A2 both sell from, so that a transfer can carry the products of both
  let shared: { id: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    inventory = app.get(InventoryService)
    shared = await createWarehouse(owner, { organizationId: ctx.orgA.id, name: 'Shared' })
    for (const storeId of [ctx.storeA.id, ctx.storeA2.id]) {
      await linkWarehouse(owner, { organizationId: ctx.orgA.id, storeId, warehouseId: shared.id })
    }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const transferOf = (response: { body: unknown }) => response.body as TransferBody

  // A product of store A (or of the store given) with stock in the warehouse given
  async function stocked(options: {
    quantity?: number
    storeId?: string
    warehouseId?: string
    unitCostCents?: number
  }) {
    const storeId = options.storeId ?? ctx.storeA.id
    const product = await createProduct(owner, { storeId })
    await inventory.move({
      storeId,
      productId: product.id,
      warehouseId: options.warehouseId ?? ctx.warehouseA.id,
      type: Type.RECEIPT,
      quantity: options.quantity ?? 10,
      reason: InventoryAdjustmentReason.OPENING_STOCK,
      idempotencyKey: randomUUID(),
      ...(options.unitCostCents === undefined ? {} : { unitCostCents: options.unitCostCents })
    })
    return { storeId, productId: product.id }
  }
  const onHand = async (
    item: { storeId: string; productId: string },
    warehouseId: string
  ): Promise<number> =>
    (
      await owner.inventoryLevel.findFirst({
        where: { storeId: item.storeId, productId: item.productId, warehouseId }
      })
    )?.onHand ?? 0
  const draft = async (
    items: { productId: string; quantity: number; variantId?: string }[],
    change: Record<string, unknown> = {},
    agent = asAdmin()
  ) => {
    const response = await agent.post(ApiRoutes.transfers.create).send({
      fromWarehouseId: ctx.warehouseA.id,
      toWarehouseId: shared.id,
      lines: items,
      ...change
    })
    expect(response.status).toBe(CREATED)
    return transferOf(response)
  }
  const dispatch = (id: string, agent = asAdmin()) => agent.post(ApiRoutes.transfers.dispatch(id))
  const receive = (
    id: string,
    lines: { lineId: string; quantity: number }[],
    receiptKey: string = randomUUID(),
    agent = asAdmin()
  ) => agent.post(ApiRoutes.transfers.receive(id)).send({ receiptKey, lines })
  const close = (
    id: string,
    lines: { lineId: string; action: TransferShortageAction }[],
    agent = asAdmin()
  ) => agent.post(ApiRoutes.transfers.close(id)).send({ lines })
  const cancel = (id: string, agent = asAdmin()) => agent.post(ApiRoutes.transfers.cancel(id))
  const stateOf = (id: string) => owner.stockTransfer.findUniqueOrThrow({ where: { id } })

  describe('a draft', () => {
    it('is made with the next number of the organization and the lines of the caller, 201', async () => {
      const item = await stocked({})

      const made = await draft([{ productId: item.productId, quantity: 4 }], { note: 'restock' })

      expect(made.number).toMatch(/^TR-\d{4,}$/)
      expect(made.status).toBe(TransferStatus.DRAFT)
      expect(made.lines).toHaveLength(1)
      expect(made.lines[0]).toMatchObject({
        storeId: ctx.storeA.id,
        productId: item.productId,
        quantity: 4,
        receivedQuantity: 0,
        pendingQuantity: 4
      })
      const second = await draft([])
      expect(Number(second.number.slice(3))).toBe(Number(made.number.slice(3)) + 1)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.TRANSFER_CREATED,
        resourceId: made.id
      })
      expect(entries[0]).toMatchObject({ userId: ctx.adminA.id, storeId: ctx.storeA.id })
    })

    it('refuses the same warehouse twice, a warehouse of another organization, and a switched-off one', async () => {
      const same = await asAdmin()
        .post(ApiRoutes.transfers.create)
        .send({ fromWarehouseId: shared.id, toWarehouseId: shared.id })
      expect(same.status).toBe(CONFLICT)
      expect(errorOf(same).code).toBe(ErrorCodes.INVENTORY_TRANSFER_SAME_WAREHOUSE)

      const foreign = await asAdmin()
        .post(ApiRoutes.transfers.create)
        .send({ fromWarehouseId: ctx.warehouseA.id, toWarehouseId: ctx.warehouseB.id })
      expect(foreign.status).toBe(NOT_FOUND)

      const off = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      await owner.warehouse.update({ where: { id: off.id }, data: { active: false } })
      const inactive = await asAdmin()
        .post(ApiRoutes.transfers.create)
        .send({ fromWarehouseId: ctx.warehouseA.id, toWarehouseId: off.id })
      expect(inactive.status).toBe(CONFLICT)
      expect(errorOf(inactive).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_INACTIVE)
    })

    it('refuses a line the store does not sell from both warehouses, a product of another store, and a product that tracks no stock', async () => {
      // Store A2 is not linked to the second warehouse of store A
      const sibling = await stocked({ storeId: ctx.storeA2.id })
      const asAdminA2 = api(app, ctx.adminA2, ctx.storeA2)
      const unlinked = await asAdminA2.post(ApiRoutes.transfers.create).send({
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: ctx.warehouseASecond.id,
        lines: [{ productId: sibling.productId, quantity: 1 }]
      })
      expect(unlinked.status).toBe(CONFLICT)
      expect(errorOf(unlinked).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED)

      // The product of store A2 is not one the admin of store A can see
      const hidden = await asAdmin()
        .post(ApiRoutes.transfers.create)
        .send({
          fromWarehouseId: ctx.warehouseA.id,
          toWarehouseId: shared.id,
          lines: [{ productId: sibling.productId, quantity: 1 }]
        })
      expect(hidden.status).toBe(NOT_FOUND)

      const service = await createProduct(owner, { storeId: ctx.storeA.id })
      await owner.product.update({ where: { id: service.id }, data: { trackInventory: false } })
      const untracked = await asAdmin()
        .post(ApiRoutes.transfers.create)
        .send({
          fromWarehouseId: ctx.warehouseA.id,
          toWarehouseId: shared.id,
          lines: [{ productId: service.id, quantity: 1 }]
        })
      expect(untracked.status).toBe(CONFLICT)
      expect(errorOf(untracked).code).toBe(ErrorCodes.INVENTORY_PRODUCT_NOT_TRACKED)
    })

    it('needs the variant when the product has them, refuses an item named twice and a quantity that is not whole', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const variant = await createProductVariant(owner, { productId: product.id })
      const body = (lines: unknown[]) => ({
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: shared.id,
        lines
      })

      const bare = await asAdmin()
        .post(ApiRoutes.transfers.create)
        .send(body([{ productId: product.id, quantity: 1 }]))
      expect(bare.status).toBe(CONFLICT)
      expect(errorOf(bare).code).toBe(ErrorCodes.INVENTORY_VARIANT_REQUIRED)

      const twice = await asAdmin()
        .post(ApiRoutes.transfers.create)
        .send(
          body([
            { productId: product.id, variantId: variant.id, quantity: 1 },
            { productId: product.id, variantId: variant.id, quantity: 2 }
          ])
        )
      expect(twice.status).toBe(BAD_REQUEST)
      for (const quantity of [0, -3, 1.5]) {
        const response = await asAdmin()
          .post(ApiRoutes.transfers.create)
          .send(body([{ productId: product.id, variantId: variant.id, quantity }]))
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('is edited while it is a draft: the lines sent replace the lines of the caller, and the warehouses can change', async () => {
      const first = await stocked({})
      const second = await stocked({})
      const made = await draft([{ productId: first.productId, quantity: 1 }])

      const response = await asAdmin()
        .patch(ApiRoutes.transfers.byId(made.id))
        .send({
          note: 'changed',
          toWarehouseId: ctx.warehouseASecond.id,
          lines: [{ productId: second.productId, quantity: 3 }]
        })

      expect(response.status).toBe(OK)
      const updated = transferOf(response)
      expect(updated.lines.map(line => [line.productId, line.quantity])).toEqual([
        [second.productId, 3]
      ])
      expect(await owner.stockTransferLine.count({ where: { transferId: made.id } })).toBe(1)
      expect((await stateOf(made.id)).toWarehouseId).toBe(ctx.warehouseASecond.id)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.TRANSFER_UPDATED,
        resourceId: made.id
      })
      expect((entries[0]?.metadata as { fields: string[] }).fields).toContain('lines')
    })

    it('cannot be edited once it left, and an empty body is refused', async () => {
      const item = await stocked({})
      const made = await draft([{ productId: item.productId, quantity: 1 }])
      expect((await dispatch(made.id)).status).toBe(OK)

      const late = await asAdmin()
        .patch(ApiRoutes.transfers.byId(made.id))
        .send({ note: 'too late' })
      expect(late.status).toBe(CONFLICT)
      expect(errorOf(late).code).toBe(ErrorCodes.INVENTORY_TRANSFER_INVALID_STATUS_TRANSITION)
      const empty = await asAdmin().patch(ApiRoutes.transfers.byId(made.id)).send({})
      expect(empty.status).toBe(BAD_REQUEST)
    })
  })

  describe('the catalog', () => {
    it('keeps a product, and a variant, that a transfer names: 409 has_history, and nothing is deleted', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const variant = await createProductVariant(owner, { productId: product.id })
      await owner.inventoryLevel.deleteMany({ where: { productId: product.id } })
      await draft([{ productId: product.id, variantId: variant.id, quantity: 1 }])

      const variantRefused = await asAdmin().delete(
        ApiRoutes.products.variantById(product.id, variant.id)
      )
      expect(variantRefused.status).toBe(CONFLICT)
      expect(errorOf(variantRefused).metadata).toMatchObject({
        conflict: ProductConflicts.HAS_HISTORY,
        [ProductHistoryTables.TRANSFER_LINES]: 1
      })
      const productRefused = await asAdmin().delete(ApiRoutes.products.byId(product.id))
      expect(productRefused.status).toBe(CONFLICT)
      expect(errorOf(productRefused).metadata).toMatchObject({
        conflict: ProductConflicts.HAS_HISTORY,
        [ProductHistoryTables.TRANSFER_LINES]: 1
      })
      expect(await owner.product.count({ where: { id: product.id } })).toBe(1)
      expect(await owner.productVariant.count({ where: { id: variant.id } })).toBe(1)
    })
  })

  describe('the warehouses of a transfer in transit', () => {
    it('are not switched off, and a store that has units on the road is not unlinked from them', async () => {
      // A destination of its own, with no stock in it: the other tests of the file leave units in the shared one
      const destination = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      await linkWarehouse(owner, {
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        warehouseId: destination.id
      })
      const item = await stocked({ quantity: 4 })
      const made = await draft([{ productId: item.productId, quantity: 4 }], {
        toWarehouseId: destination.id
      })
      await dispatch(made.id)

      // The destination holds no stock (the units are on the road), and still cannot be switched off
      const off = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(destination.id))
        .send({ active: false })
      expect(off.status).toBe(CONFLICT)
      expect(errorOf(off).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_HAS_STOCK)
      expect(errorOf(off).metadata).toMatchObject({ reason: WarehouseStockBlocks.OPEN_TRANSFER })
      expect(
        (await owner.warehouse.findUniqueOrThrow({ where: { id: destination.id } })).active
      ).toBe(true)

      const links = await asAdmin()
        .put(ApiRoutes.warehouses.stores(destination.id))
        .send({ stores: [] })
      expect(links.status).toBe(CONFLICT)
      expect(errorOf(links).metadata).toMatchObject({
        reason: WarehouseStockBlocks.OPEN_TRANSFER,
        storeId: ctx.storeA.id
      })
      expect(await owner.storeWarehouse.count({ where: { warehouseId: destination.id } })).toBe(1)

      // Once it is over they are free again
      await cancel(made.id)
      const freed = await asAdmin()
        .patch(ApiRoutes.warehouses.byId(destination.id))
        .send({ active: false })
      expect(freed.status).toBe(OK)
    })
  })

  describe('the product of a transfer in transit', () => {
    it('keeps tracking its stock: switching it off is refused while its units are on the road', async () => {
      const item = await stocked({ quantity: 3 })
      const made = await draft([{ productId: item.productId, quantity: 3 }])
      await dispatch(made.id)

      const off = await asAdmin()
        .patch(ApiRoutes.products.byId(item.productId))
        .send({ trackInventory: false })

      expect(off.status).toBe(CONFLICT)
      expect(errorOf(off).metadata).toMatchObject({ conflict: ProductConflicts.IN_TRANSIT })
      expect(
        (await owner.product.findUniqueOrThrow({ where: { id: item.productId } })).trackInventory
      ).toBe(true)
      await cancel(made.id)
      const freed = await asAdmin()
        .patch(ApiRoutes.products.byId(item.productId))
        .send({ trackInventory: false })
      expect(freed.status).toBe(OK)
    })
  })

  describe('dispatching', () => {
    it('takes every line out of the source with TRANSFER_OUT, moves the status and tells who may receive', async () => {
      const a = await stocked({ quantity: 10 })
      const b = await stocked({ quantity: 5 })
      const made = await draft([
        { productId: a.productId, quantity: 4 },
        { productId: b.productId, quantity: 5 }
      ])

      const response = await dispatch(made.id)

      expect(response.status).toBe(OK)
      expect(transferOf(response).status).toBe(TransferStatus.IN_TRANSIT)
      expect(await onHand(a, ctx.warehouseA.id)).toBe(6)
      expect(await onHand(b, ctx.warehouseA.id)).toBe(0)
      // Nothing is at the destination until it is received
      expect(await onHand(a, shared.id)).toBe(0)
      const movements = await owner.inventoryMovement.findMany({
        where: { referenceId: made.id, type: Type.TRANSFER_OUT }
      })
      expect(movements).toHaveLength(2)
      expect(movements[0]).toMatchObject({
        referenceType: 'transfer',
        warehouseId: ctx.warehouseA.id
      })
      const row = await stateOf(made.id)
      expect(row).toMatchObject({ status: 'in_transit', dispatchedBy: ctx.adminA.id })
      expect(row.dispatchedAt).not.toBeNull()
      expect(
        (
          await waitForAuditEntries(owner, {
            action: AuditAction.TRANSFER_DISPATCHED,
            resourceId: made.id
          })
        )[0]
      ).toMatchObject({ userId: ctx.adminA.id })
      await waitFor(async () => {
        const rows = await owner.notification.findMany({
          where: {
            storeId: ctx.storeA.id,
            type: NotificationTypes.TRANSFER_DISPATCHED,
            resourceId: made.id
          }
        })
        return rows.map(item => item.userId).includes(ctx.adminA.id)
      })
    })

    it('needs real available stock: reserved units cannot leave, and then nothing at all is dispatched', async () => {
      const ok = await stocked({ quantity: 10 })
      const reserved = await stocked({ quantity: 10 })
      await inventory.reserve({
        storeId: reserved.storeId,
        productId: reserved.productId,
        warehouseId: ctx.warehouseA.id,
        quantity: 8,
        idempotencyKey: randomUUID()
      })
      const made = await draft([
        { productId: ok.productId, quantity: 5 },
        { productId: reserved.productId, quantity: 5 }
      ])

      const response = await dispatch(made.id)

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.INSUFFICIENT_INVENTORY)
      expect(await onHand(ok, ctx.warehouseA.id)).toBe(10)
      expect((await stateOf(made.id)).status).toBe('draft')
      expect(await owner.inventoryMovement.count({ where: { referenceId: made.id } })).toBe(0)
    })

    it('needs real stock even where the store allows negative stock', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { allowNegativeStock: true }
      })
      try {
        const item = await stocked({ quantity: 2 })
        const made = await draft([{ productId: item.productId, quantity: 5 }])
        const response = await dispatch(made.id)
        expect(response.status).toBe(CONFLICT)
        expect(errorOf(response).code).toBe(ErrorCodes.INSUFFICIENT_INVENTORY)
      } finally {
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { allowNegativeStock: false }
        })
      }
    })

    it('refuses a transfer with no line, one that already left, and one cancelled', async () => {
      const empty = await draft([])
      const noLines = await dispatch(empty.id)
      expect(noLines.status).toBe(CONFLICT)
      expect(errorOf(noLines).code).toBe(ErrorCodes.INVENTORY_TRANSFER_EMPTY)

      const item = await stocked({})
      const made = await draft([{ productId: item.productId, quantity: 1 }])
      expect((await dispatch(made.id)).status).toBe(OK)
      const again = await dispatch(made.id)
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).code).toBe(ErrorCodes.INVENTORY_TRANSFER_INVALID_STATUS_TRANSITION)
      expect(await onHand(item, ctx.warehouseA.id)).toBe(9)

      expect((await cancel(empty.id)).status).toBe(OK)
      expect((await dispatch(empty.id)).status).toBe(CONFLICT)
    })

    it('two dispatches at once leave the stock once', async () => {
      const item = await stocked({ quantity: 10 })
      const made = await draft([{ productId: item.productId, quantity: 10 }])

      const results = await Promise.all([dispatch(made.id), dispatch(made.id)])

      expect(results.map(result => result.status).sort()).toEqual([OK, CONFLICT])
      expect(await onHand(item, ctx.warehouseA.id)).toBe(0)
      expect(
        await owner.inventoryMovement.count({
          where: { referenceId: made.id, type: Type.TRANSFER_OUT }
        })
      ).toBe(1)
    })
  })

  describe('receiving', () => {
    it('writes TRANSFER_IN at the destination a part at a time, and the transfer is received when every unit arrived', async () => {
      const item = await stocked({ quantity: 10, unitCostCents: 500 })
      const made = await draft([{ productId: item.productId, quantity: 10 }])
      await dispatch(made.id)
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id

      const first = await receive(made.id, [{ lineId: line, quantity: 4 }])

      expect(first.status).toBe(OK)
      expect(transferOf(first)).toMatchObject({ status: 'in_transit' })
      expect(transferOf(first).lines[0]).toMatchObject({ receivedQuantity: 4, pendingQuantity: 6 })
      expect(await onHand(item, shared.id)).toBe(4)

      const second = await receive(made.id, [{ lineId: line, quantity: 6 }])

      expect(transferOf(second).status).toBe(TransferStatus.RECEIVED)
      expect(await onHand(item, shared.id)).toBe(10)
      expect((await stateOf(made.id)).closedAt).not.toBeNull()
      // The units arrive worth what they were when they left: a transfer moves value, it does not make it
      const level = await owner.inventoryLevel.findFirstOrThrow({
        where: { productId: item.productId, warehouseId: shared.id }
      })
      expect(level.valueCents).toBe(5000n)
      for (const warehouseId of [ctx.warehouseA.id, shared.id]) {
        const check = await inventory.checkLevel({ ...item, warehouseId })
        expect(check.matches).toBe(true)
      }
      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.TRANSFER_RECEIVED, resourceId: made.id },
        2
      )
      expect(entries).toHaveLength(2)
    })

    it('refuses more than is pending, and a transfer that has not left', async () => {
      const item = await stocked({ quantity: 10 })
      const made = await draft([{ productId: item.productId, quantity: 5 }])
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id

      const early = await receive(made.id, [{ lineId: line, quantity: 1 }])
      expect(early.status).toBe(CONFLICT)
      expect(errorOf(early).code).toBe(ErrorCodes.INVENTORY_TRANSFER_INVALID_STATUS_TRANSITION)

      await dispatch(made.id)
      await receive(made.id, [{ lineId: line, quantity: 3 }])
      const over = await receive(made.id, [{ lineId: line, quantity: 3 }])
      expect(over.status).toBe(CONFLICT)
      expect(errorOf(over).code).toBe(ErrorCodes.INVENTORY_TRANSFER_RECEIVE_EXCEEDS_DISPATCHED)
      expect(errorOf(over).metadata).toMatchObject({ pending: 2 })
      expect(await onHand(item, shared.id)).toBe(3)
      const unknown = await receive(made.id, [{ lineId: randomUUID(), quantity: 1 }])
      expect(unknown.status).toBe(NOT_FOUND)
    })

    it('applies a retry once: the same receipt key answers the same, and for another receipt it is a 409', async () => {
      const item = await stocked({ quantity: 10 })
      const made = await draft([{ productId: item.productId, quantity: 10 }])
      await dispatch(made.id)
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id
      const key = randomUUID()

      expect((await receive(made.id, [{ lineId: line, quantity: 4 }], key)).status).toBe(OK)
      const retry = await receive(made.id, [{ lineId: line, quantity: 4 }], key)

      expect(retry.status).toBe(OK)
      expect(transferOf(retry).lines[0]?.receivedQuantity).toBe(4)
      expect(await onHand(item, shared.id)).toBe(4)
      const reused = await receive(made.id, [{ lineId: line, quantity: 5 }], key)
      expect(reused.status).toBe(CONFLICT)
      expect(errorOf(reused).metadata).toMatchObject({
        conflict: InventoryConflicts.IDEMPOTENCY_KEY_REUSED
      })
      expect(await onHand(item, shared.id)).toBe(4)
    })

    it('the same receipt key for another set of lines is a 409 too, whichever line is named', async () => {
      const one = await stocked({ quantity: 5 })
      const two = await stocked({ quantity: 5 })
      const made = await draft([
        { productId: one.productId, quantity: 5 },
        { productId: two.productId, quantity: 5 }
      ])
      await dispatch(made.id)
      const lines = await owner.stockTransferLine.findMany({ where: { transferId: made.id } })
      const lineOne = lines.find(line => line.productId === one.productId)?.id ?? ''
      const lineTwo = lines.find(line => line.productId === two.productId)?.id ?? ''
      const key = randomUUID()
      expect((await receive(made.id, [{ lineId: lineOne, quantity: 2 }], key)).status).toBe(OK)

      const other = await receive(made.id, [{ lineId: lineTwo, quantity: 2 }], key)

      expect(other.status).toBe(CONFLICT)
      expect(errorOf(other).metadata).toMatchObject({
        conflict: InventoryConflicts.IDEMPOTENCY_KEY_REUSED
      })
      expect(await onHand(two, shared.id)).toBe(0)
    })

    it('a retry of the receipt that completed the transfer answers it too', async () => {
      const item = await stocked({ quantity: 3 })
      const made = await draft([{ productId: item.productId, quantity: 3 }])
      await dispatch(made.id)
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id
      const key = randomUUID()
      await receive(made.id, [{ lineId: line, quantity: 3 }], key)

      const retry = await receive(made.id, [{ lineId: line, quantity: 3 }], key)

      expect(retry.status).toBe(OK)
      expect(transferOf(retry).status).toBe(TransferStatus.RECEIVED)
      expect(await onHand(item, shared.id)).toBe(3)
    })

    it('two receipts at once never take in more than was sent', async () => {
      const item = await stocked({ quantity: 10 })
      const made = await draft([{ productId: item.productId, quantity: 10 }])
      await dispatch(made.id)
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id

      const results = await Promise.all([
        receive(made.id, [{ lineId: line, quantity: 7 }]),
        receive(made.id, [{ lineId: line, quantity: 7 }])
      ])

      expect(results.map(result => result.status).sort()).toEqual([OK, CONFLICT])
      expect(await onHand(item, shared.id)).toBe(7)
    })
  })

  describe('closing with a shortage', () => {
    it('writes off or sends back each short line, and the transfer is received', async () => {
      const lost = await stocked({ quantity: 10, unitCostCents: 300 })
      const back = await stocked({ quantity: 10, unitCostCents: 300 })
      const whole = await stocked({ quantity: 10 })
      const made = await draft([
        { productId: lost.productId, quantity: 10 },
        { productId: back.productId, quantity: 10 },
        { productId: whole.productId, quantity: 2 }
      ])
      await dispatch(made.id)
      const lines = await owner.stockTransferLine.findMany({ where: { transferId: made.id } })
      const lineOf = (item: { productId: string }) =>
        lines.find(candidate => candidate.productId === item.productId)?.id ?? ''
      await receive(made.id, [
        { lineId: lineOf(lost), quantity: 6 },
        { lineId: lineOf(back), quantity: 6 },
        { lineId: lineOf(whole), quantity: 2 }
      ])

      const response = await close(made.id, [
        { lineId: lineOf(lost), action: TransferShortageAction.WRITE_OFF },
        { lineId: lineOf(back), action: TransferShortageAction.RETURN_TO_SOURCE }
      ])

      expect(response.status).toBe(OK)
      expect(transferOf(response).status).toBe(TransferStatus.RECEIVED)
      // Written off: the 4 units that did not arrive are gone; sent back: they are on the shelf of the source again
      expect(await onHand(lost, ctx.warehouseA.id)).toBe(0)
      expect(await onHand(back, ctx.warehouseA.id)).toBe(4)
      expect(
        await owner.inventoryMovement.count({
          where: {
            referenceId: made.id,
            productId: lost.productId,
            type: Type.TRANSFER_IN,
            warehouseId: ctx.warehouseA.id
          }
        })
      ).toBe(0)
      const stored = await owner.stockTransferLine.findMany({ where: { transferId: made.id } })
      expect(stored.find(line => line.id === lineOf(lost))?.shortageAction).toBe('write_off')
      expect(stored.find(line => line.id === lineOf(whole))?.shortageAction).toBeNull()
      const returned = await owner.inventoryLevel.findFirstOrThrow({
        where: { productId: back.productId, warehouseId: ctx.warehouseA.id }
      })
      expect(returned.valueCents).toBe(1200n)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.TRANSFER_CLOSED_WITH_SHORTAGE,
        resourceId: made.id
      })
      const shortages = (entries[0]?.metadata as { shortages: { missing: number }[] }).shortages
      expect(shortages.map(shortage => shortage.missing).sort()).toEqual([4, 4])
      expect((await close(made.id, [])).status).toBe(CONFLICT)
    })

    it('asks an action for every short line, none for a complete one, and nothing is closed on a mistake', async () => {
      const short = await stocked({ quantity: 10 })
      const full = await stocked({ quantity: 10 })
      const made = await draft([
        { productId: short.productId, quantity: 5 },
        { productId: full.productId, quantity: 5 }
      ])
      await dispatch(made.id)
      const lines = await owner.stockTransferLine.findMany({ where: { transferId: made.id } })
      const shortLine = lines.find(line => line.productId === short.productId)?.id ?? ''
      const fullLine = lines.find(line => line.productId === full.productId)?.id ?? ''
      await receive(made.id, [{ lineId: fullLine, quantity: 5 }])

      const missing = await close(made.id, [])
      expect(missing.status).toBe(BAD_REQUEST)
      expect(errorOf(missing).code).toBe(ErrorCodes.INVENTORY_TRANSFER_SHORTAGE_ACTION_INVALID)
      const complete = await close(made.id, [
        { lineId: shortLine, action: TransferShortageAction.WRITE_OFF },
        { lineId: fullLine, action: TransferShortageAction.WRITE_OFF }
      ])
      expect(complete.status).toBe(BAD_REQUEST)
      const early = await close((await draft([{ productId: short.productId, quantity: 1 }])).id, [])
      expect(early.status).toBe(CONFLICT)
      expect((await stateOf(made.id)).status).toBe('in_transit')
      expect(await onHand(short, ctx.warehouseA.id)).toBe(5)
    })
  })

  describe('cancelling', () => {
    it('a draft has nothing to undo', async () => {
      const item = await stocked({})
      const made = await draft([{ productId: item.productId, quantity: 3 }])

      const response = await cancel(made.id)

      expect(response.status).toBe(OK)
      expect(transferOf(response).status).toBe(TransferStatus.CANCELLED)
      expect(await owner.inventoryMovement.count({ where: { referenceId: made.id } })).toBe(0)
    })

    it('in transit it returns the units that have not arrived to the source', async () => {
      const item = await stocked({ quantity: 10, unitCostCents: 250 })
      const made = await draft([{ productId: item.productId, quantity: 10 }])
      await dispatch(made.id)
      expect(await onHand(item, ctx.warehouseA.id)).toBe(0)

      const response = await cancel(made.id)

      expect(response.status).toBe(OK)
      expect(transferOf(response).status).toBe(TransferStatus.CANCELLED)
      expect(await onHand(item, ctx.warehouseA.id)).toBe(10)
      expect(await onHand(item, shared.id)).toBe(0)
      const level = await owner.inventoryLevel.findFirstOrThrow({
        where: { productId: item.productId, warehouseId: ctx.warehouseA.id }
      })
      expect(level.valueCents).toBe(2500n)
      expect(
        (
          await waitForAuditEntries(owner, {
            action: AuditAction.TRANSFER_CANCELLED,
            resourceId: made.id
          })
        )[0]?.metadata
      ).toMatchObject({ wasInTransit: true, returnedUnits: 10 })
    })

    it('after a part arrived only the rest returns: what was received stays where it arrived', async () => {
      const item = await stocked({ quantity: 10 })
      const made = await draft([{ productId: item.productId, quantity: 10 }])
      await dispatch(made.id)
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id
      await receive(made.id, [{ lineId: line, quantity: 4 }])

      expect((await cancel(made.id)).status).toBe(OK)

      expect(await onHand(item, ctx.warehouseA.id)).toBe(6)
      expect(await onHand(item, shared.id)).toBe(4)
      for (const warehouseId of [ctx.warehouseA.id, shared.id]) {
        expect((await inventory.checkLevel({ ...item, warehouseId })).matches).toBe(true)
      }
    })

    it('a received or cancelled transfer cannot be cancelled', async () => {
      const item = await stocked({})
      const made = await draft([{ productId: item.productId, quantity: 2 }])
      await dispatch(made.id)
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id
      await receive(made.id, [{ lineId: line, quantity: 2 }])

      const received = await cancel(made.id)
      expect(received.status).toBe(CONFLICT)
      expect(errorOf(received).code).toBe(ErrorCodes.INVENTORY_TRANSFER_INVALID_STATUS_TRANSITION)
      const cancelled = await draft([])
      await cancel(cancelled.id)
      expect((await cancel(cancelled.id)).status).toBe(CONFLICT)
    })
  })

  describe('who sees what (TDD_16 §1)', () => {
    // An Admin of store A who is also an Admin of store A2: the one who puts the products of both in one transfer, and
    // dispatches it
    async function inBoth() {
      const actor = await createActor(owner, app, {
        prefix,
        name: `both${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      await ensureMembership(owner, {
        userId: actor.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      return api(app, actor, ctx.storeA)
    }

    // One transfer that carries a product of store A and a product of store A2
    async function mixed() {
      const mine = await stocked({ storeId: ctx.storeA.id })
      const theirs = await stocked({ storeId: ctx.storeA2.id })
      const asAdminA2 = api(app, ctx.adminA2, ctx.storeA2)
      const both = await inBoth()
      const made = await draft(
        [
          { productId: mine.productId, quantity: 2 },
          { productId: theirs.productId, quantity: 3 }
        ],
        {},
        both
      )
      return { mine, theirs, made, asAdminA2, both }
    }

    it('shows each user only the lines of the stores they belong to, in the detail and in the counts of the list', async () => {
      const { mine, theirs, made, asAdminA2 } = await mixed()

      const ofA = transferOf(await asAdmin().get(ApiRoutes.transfers.byId(made.id)))
      const ofA2 = transferOf(await asAdminA2.get(ApiRoutes.transfers.byId(made.id)))

      expect(ofA.lines.map(line => line.productId)).toEqual([mine.productId])
      expect(ofA2.lines.map(line => line.productId)).toEqual([theirs.productId])
      expect(await owner.stockTransferLine.count({ where: { transferId: made.id } })).toBe(2)
      const listA = (await asAdmin().get(ApiRoutes.transfers.list)).body as PageBody
      const listA2 = (await asAdminA2.get(ApiRoutes.transfers.list)).body as PageBody
      expect(listA.data.find(row => row.id === made.id)?.lineCount).toBe(1)
      expect(listA2.data.find(row => row.id === made.id)?.lineCount).toBe(1)
    })

    it('an edit of one store leaves the lines of the other as they were', async () => {
      const { theirs, made } = await mixed()
      const other = await stocked({ storeId: ctx.storeA.id })

      const response = await asAdmin()
        .patch(ApiRoutes.transfers.byId(made.id))
        .send({ lines: [{ productId: other.productId, quantity: 1 }] })

      expect(response.status).toBe(OK)
      const lines = await owner.stockTransferLine.findMany({ where: { transferId: made.id } })
      expect(lines.map(line => line.productId).sort()).toEqual(
        [other.productId, theirs.productId].sort()
      )
      // And a store cannot put in a product it does not own
      const stolen = await asAdmin()
        .patch(ApiRoutes.transfers.byId(made.id))
        .send({ lines: [{ productId: theirs.productId, quantity: 1 }] })
      expect(stolen.status).toBe(NOT_FOUND)
    })

    it('a line of another store cannot be received or closed by someone who does not see it', async () => {
      const { mine, theirs, made, asAdminA2, both } = await mixed()
      // The stock of every line leaves with a dispatch: whoever does it belongs to every store whose units travel
      const blindDispatch = await dispatch(made.id)
      expect(blindDispatch.status).toBe(CONFLICT)
      expect(errorOf(blindDispatch).code).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect(await onHand(theirs, ctx.warehouseA.id)).toBe(10)
      expect((await dispatch(made.id, both)).status).toBe(OK)
      const lines = await owner.stockTransferLine.findMany({ where: { transferId: made.id } })
      const hisLine = lines.find(line => line.productId === theirs.productId)?.id ?? ''
      const myLine = lines.find(line => line.productId === mine.productId)?.id ?? ''

      const blind = await receive(made.id, [{ lineId: hisLine, quantity: 1 }])
      expect(blind.status).toBe(NOT_FOUND)
      expect(await onHand(theirs, shared.id)).toBe(0)

      expect((await receive(made.id, [{ lineId: myLine, quantity: 2 }])).status).toBe(OK)
      // Store A's units all arrived; store A2's did not, and the admin of A cannot decide for them
      const stuck = await close(made.id, [])
      expect(stuck.status).toBe(CONFLICT)
      expect(errorOf(stuck).code).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect((await stateOf(made.id)).status).toBe('in_transit')
      // Nor can they cancel it: the units of store A2 would go back to a store they do not belong to
      const noCancel = await cancel(made.id)
      expect(noCancel.status).toBe(CONFLICT)
      expect(errorOf(noCancel).code).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)

      const own = await close(
        made.id,
        [{ lineId: hisLine, action: TransferShortageAction.RETURN_TO_SOURCE }],
        asAdminA2
      )
      expect(own.status).toBe(OK)
      expect(await onHand(theirs, ctx.warehouseA.id)).toBe(10)
    })

    it('a transfer made only of lines of other stores is not shown, header included, and cannot be edited', async () => {
      const theirs = await stocked({ storeId: ctx.storeA2.id })
      const asAdminA2 = api(app, ctx.adminA2, ctx.storeA2)
      const made = await asAdminA2.post(ApiRoutes.transfers.create).send({
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: shared.id,
        note: 'private to store A2',
        lines: [{ productId: theirs.productId, quantity: 1 }]
      })
      expect(made.status).toBe(CREATED)
      const id = transferOf(made).id

      expect((await asAdmin().get(ApiRoutes.transfers.byId(id))).status).toBe(NOT_FOUND)
      const list = (await asAdmin().get(`${ApiRoutes.transfers.list}?limit=100`)).body as PageBody
      expect(list.data.map(row => row.id)).not.toContain(id)
      const edit = await asAdmin().patch(ApiRoutes.transfers.byId(id)).send({ note: 'mine now' })
      expect(edit.status).toBe(NOT_FOUND)
      expect((await stateOf(id)).note).toBe('private to store A2')
      expect((await asAdminA2.get(ApiRoutes.transfers.byId(id))).status).toBe(OK)
    })

    it('does not let the warehouses of a transfer with lines the caller cannot see be changed, and a note is fine', async () => {
      const { made } = await mixed()

      const moved = await asAdmin()
        .patch(ApiRoutes.transfers.byId(made.id))
        .send({ toWarehouseId: ctx.warehouseASecond.id })
      expect(moved.status).toBe(CONFLICT)
      expect(errorOf(moved).code).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect((await stateOf(made.id)).toWarehouseId).toBe(shared.id)
      const noted = await asAdmin()
        .patch(ApiRoutes.transfers.byId(made.id))
        .send({ note: 'only a note' })
      expect(noted.status).toBe(OK)
    })

    it('a store where the caller holds no transfer permission is not theirs: they cannot name its products', async () => {
      // Admin of store A, and only an Agent (who views the inventory) of store A2
      const actor = await createActor(owner, app, {
        prefix,
        name: `half${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      await ensureMembership(owner, {
        userId: actor.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const theirs = await stocked({ storeId: ctx.storeA2.id })

      const response = await api(app, actor, ctx.storeA)
        .post(ApiRoutes.transfers.create)
        .send({
          fromWarehouseId: ctx.warehouseA.id,
          toWarehouseId: shared.id,
          lines: [{ productId: theirs.productId, quantity: 1 }]
        })

      expect(response.status).toBe(NOT_FOUND)
    })

    it('another organization sees no transfer of this one', async () => {
      const item = await stocked({})
      const made = await draft([{ productId: item.productId, quantity: 1 }])
      const asB = api(app, ctx.adminB, ctx.storeB)

      expect((await asB.get(ApiRoutes.transfers.byId(made.id))).status).toBe(NOT_FOUND)
      expect((await asB.post(ApiRoutes.transfers.dispatch(made.id))).status).toBe(NOT_FOUND)
      expect((await asB.post(ApiRoutes.transfers.cancel(made.id))).status).toBe(NOT_FOUND)
      const list = (await asB.get(ApiRoutes.transfers.list)).body as PageBody
      expect(list.data.map(row => row.id)).not.toContain(made.id)
      expect((await stateOf(made.id)).status).toBe('draft')
    })
  })

  describe('permissions', () => {
    const member = (
      name: string,
      permissions: Parameters<typeof actorWithPermissions>[2]['permissions']
    ) =>
      actorWithPermissions(owner, app, {
        prefix,
        name: `${name}${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions
      })

    it('a member who only views the inventory cannot read or touch a transfer', async () => {
      const item = await stocked({})
      const made = await draft([{ productId: item.productId, quantity: 1 }])
      const viewer = api(app, ctx.agentA, ctx.storeA)

      for (const response of [
        await viewer.get(ApiRoutes.transfers.list),
        await viewer.get(ApiRoutes.transfers.byId(made.id)),
        await viewer.post(ApiRoutes.transfers.create).send({}),
        await viewer.patch(ApiRoutes.transfers.byId(made.id)).send({ note: 'x' }),
        await viewer.post(ApiRoutes.transfers.dispatch(made.id)),
        await receive(made.id, [], randomUUID(), viewer),
        await close(made.id, [], viewer),
        await viewer.post(ApiRoutes.transfers.cancel(made.id))
      ]) {
        expect(response.status).toBe(FORBIDDEN)
      }
    })

    it('managing is not receiving: each permission opens its own routes, and either reads', async () => {
      const manager = api(
        app,
        await member('manager', [Permissions.INVENTORY_MANAGE_TRANSFERS]),
        ctx.storeA
      )
      const receiver = api(
        app,
        await member('receiver', [Permissions.INVENTORY_RECEIVE_TRANSFERS]),
        ctx.storeA
      )
      const item = await stocked({})
      const made = await draft([{ productId: item.productId, quantity: 2 }], {}, manager)
      const line = (
        await owner.stockTransferLine.findFirstOrThrow({ where: { transferId: made.id } })
      ).id

      expect((await receiver.get(ApiRoutes.transfers.byId(made.id))).status).toBe(OK)
      expect((await manager.get(ApiRoutes.transfers.list)).status).toBe(OK)
      expect((await receiver.post(ApiRoutes.transfers.dispatch(made.id))).status).toBe(FORBIDDEN)
      expect((await receiver.post(ApiRoutes.transfers.create).send({})).status).toBe(FORBIDDEN)
      expect((await receiver.post(ApiRoutes.transfers.cancel(made.id))).status).toBe(FORBIDDEN)
      expect((await dispatch(made.id, manager)).status).toBe(OK)
      expect(
        (await receive(made.id, [{ lineId: line, quantity: 1 }], randomUUID(), manager)).status
      ).toBe(FORBIDDEN)
      expect((await close(made.id, [], manager)).status).toBe(FORBIDDEN)
      expect(
        (await receive(made.id, [{ lineId: line, quantity: 2 }], randomUUID(), receiver)).status
      ).toBe(OK)
    })
  })

  describe('the list', () => {
    it('pages the newest first with a cursor and filters by status and warehouse', async () => {
      const made = [await draft([]), await draft([]), await draft([])]
      await cancel(made[0]?.id ?? '')

      const first = (await asAdmin().get(`${ApiRoutes.transfers.list}?limit=2`)).body as PageBody
      expect(first.data).toHaveLength(2)
      expect(first.hasMore).toBe(true)
      const second = (
        await asAdmin().get(`${ApiRoutes.transfers.list}?limit=2&cursor=${first.nextCursor}`)
      ).body as PageBody
      const seen = [...first.data, ...second.data].map(row => row.id)
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen.indexOf(made[2]?.id ?? '')).toBeLessThan(seen.indexOf(made[1]?.id ?? ''))

      const cancelled = (
        await asAdmin().get(`${ApiRoutes.transfers.list}?status=cancelled&limit=100`)
      ).body as PageBody
      expect(cancelled.data.map(row => row.id)).toContain(made[0]?.id)
      expect(cancelled.data.map(row => row.id)).not.toContain(made[1]?.id)
      // A transfer that goes to the second warehouse: the filter finds it, from either end, and only it
      const toSecond = await draft([], { toWarehouseId: ctx.warehouseASecond.id })
      const idsFor = async (warehouseId: string): Promise<string[]> =>
        (
          (await asAdmin().get(`${ApiRoutes.transfers.list}?warehouseId=${warehouseId}&limit=100`))
            .body as PageBody
        ).data.map(row => row.id)
      const forSecond = await idsFor(ctx.warehouseASecond.id)
      expect(forSecond).toContain(toSecond.id)
      expect(forSecond).not.toContain(made[1]?.id)
      const forSource = await idsFor(ctx.warehouseA.id)
      expect(forSource).toContain(toSecond.id)
      expect(forSource).toContain(made[1]?.id)
      expect((await asAdmin().get(`${ApiRoutes.transfers.list}?cursor=nonsense`)).status).toBe(
        BAD_REQUEST
      )
    })
  })
})

async function waitFor(check: () => Promise<boolean>, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('the condition did not hold in time')
}
