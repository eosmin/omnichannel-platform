import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { RoleNames } from '@platform/core/auth'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  CountStatus,
  InventoryMovementType,
  InventoryReferenceType,
  TransferStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import {
  createInventoryLevel,
  createProduct,
  createWarehouse,
  linkWarehouse,
  uniqueTransferNumber
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api, type Actor } from '../helpers/http'

interface ErrorBody {
  error: { code: string }
}

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const STOCK = 10

// RLS phase 6: with the switch ON the context of a request holds the store of X-Store-Id alone. A transfer or a count of an
// organization carries lines of SEVERAL of its stores (TDD_16 §1), and the person who moves them belongs to all of them. Their
// lines used to be invisible to the request, so "the caller sees every line" was decided on what was left: the dispatch or the
// apply went through for the store of the header and silently skipped the others (a transfer in transit, a count applied, with
// the stock of the second store untouched), and a write to a store outside the context was refused by the policy (42501).
// The app below is the real one, on the role of the api, with the switch on and a context required for every query.
describe('RLS phase 6: transfers and counts with lines of several stores of one organization', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  // A warehouse that stores A and A2 both sell from, as the destination of a transfer
  let shared: { id: string }
  // Admin of store A and of its sibling A2: the person the flow is made for
  let both: Actor
  // Admin of store A, and only an Agent (no transfer or count permission) of A2
  let half: Actor

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().app,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
    shared = await createWarehouse(owner, { organizationId: ctx.orgA.id, name: 'Shared' })
    for (const storeId of [ctx.storeA.id, ctx.storeA2.id]) {
      await linkWarehouse(owner, { organizationId: ctx.orgA.id, storeId, warehouseId: shared.id })
    }
    both = await createActor(owner, app, {
      prefix,
      name: `both${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    await ensureMembership(owner, {
      userId: both.id,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    half = await createActor(owner, app, {
      prefix,
      name: `half${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    await ensureMembership(owner, {
      userId: half.id,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await guarded.onModuleDestroy()
    await owner.$disconnect()
  })

  const asBoth = () => api(app, both, ctx.storeA)
  const asHalf = () => api(app, half, ctx.storeA)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error

  // A product of the store with STOCK units in the warehouse given, written as the owner (the fixture is not what is under test)
  async function stocked(storeId: string, warehouseId: string) {
    const product = await createProduct(owner, { storeId })
    await createInventoryLevel(owner, {
      storeId,
      productId: product.id,
      warehouseId,
      onHand: STOCK
    })
    return { storeId, productId: product.id, warehouseId }
  }
  const onHand = async (item: { storeId: string; productId: string }, warehouseId: string) =>
    (
      await owner.inventoryLevel.findFirst({
        where: { storeId: item.storeId, productId: item.productId, warehouseId }
      })
    )?.onHand ?? 0

  // A draft transfer of the organization with one line of store A and one of store A2, written as the owner
  async function mixedTransfer() {
    const mine = await stocked(ctx.storeA.id, ctx.warehouseA.id)
    const theirs = await stocked(ctx.storeA2.id, ctx.warehouseA.id)
    const transfer = await owner.stockTransfer.create({
      data: {
        organizationId: ctx.orgA.id,
        number: uniqueTransferNumber(),
        fromWarehouseId: ctx.warehouseA.id,
        toWarehouseId: shared.id,
        status: TransferStatus.DRAFT,
        createdBy: both.id,
        lines: {
          create: [mine, theirs].map(item => ({
            storeId: item.storeId,
            productId: item.productId,
            quantity: 4
          }))
        }
      },
      select: { id: true, lines: { select: { id: true, storeId: true } } }
    })
    return { mine, theirs, transfer }
  }

  // A count of the warehouse in review: store A counted 3 more than the snapshot, store A2 counted 3 fewer
  async function mixedCount() {
    const mine = await stocked(ctx.storeA.id, ctx.warehouseA.id)
    const theirs = await stocked(ctx.storeA2.id, ctx.warehouseA.id)
    const count = await owner.stockCount.create({
      data: {
        organizationId: ctx.orgA.id,
        warehouseId: ctx.warehouseA.id,
        number: `CT-${randomUUID().replace(/\D/g, '').slice(0, 8).padEnd(4, '0')}`,
        status: CountStatus.REVIEW,
        createdBy: both.id,
        startedAt: new Date(),
        submittedAt: new Date(),
        lines: {
          create: [
            { ...mine, expectedQuantity: STOCK, countedQuantity: STOCK + 3 },
            { ...theirs, expectedQuantity: STOCK, countedQuantity: STOCK - 3 }
          ].map(({ storeId, productId, expectedQuantity, countedQuantity }) => ({
            storeId,
            productId,
            expectedQuantity,
            countedQuantity
          }))
        }
      },
      select: { id: true }
    })
    return { mine, theirs, count }
  }

  describe('a transfer', () => {
    it('is dispatched with the units of BOTH stores leaving, or with none', async () => {
      const { mine, theirs, transfer } = await mixedTransfer()

      const response = await asBoth().post(ApiRoutes.transfers.dispatch(transfer.id))

      expect(response.status).toBe(OK)
      expect(await onHand(mine, ctx.warehouseA.id)).toBe(STOCK - 4)
      expect(await onHand(theirs, ctx.warehouseA.id)).toBe(STOCK - 4)
      const row = await owner.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })
      expect(row.status).toBe(TransferStatus.IN_TRANSIT)
      expect(
        await owner.inventoryMovement.count({
          where: {
            referenceType: InventoryReferenceType.TRANSFER,
            referenceId: transfer.id,
            type: InventoryMovementType.TRANSFER_OUT
          }
        })
      ).toBe(2)
    })

    it('writes the audit entry of a dispatch of both stores in the store of the header', async () => {
      const { transfer } = await mixedTransfer()
      expect((await asBoth().post(ApiRoutes.transfers.dispatch(transfer.id))).status).toBe(OK)

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.TRANSFER_DISPATCHED,
        resourceId: transfer.id
      })

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ userId: both.id, storeId: ctx.storeA.id })
    })

    it('is received in the destination for the lines of both stores', async () => {
      const { mine, theirs, transfer } = await mixedTransfer()
      expect((await asBoth().post(ApiRoutes.transfers.dispatch(transfer.id))).status).toBe(OK)

      const response = await asBoth()
        .post(ApiRoutes.transfers.receive(transfer.id))
        .send({
          receiptKey: randomUUID(),
          lines: transfer.lines.map(line => ({ lineId: line.id, quantity: 4 }))
        })

      expect(response.status).toBe(OK)
      expect(await onHand(mine, shared.id)).toBe(4)
      expect(await onHand(theirs, shared.id)).toBe(4)
    })

    it('is cancelled in transit with the units of both stores back at the source', async () => {
      const { mine, theirs, transfer } = await mixedTransfer()
      expect((await asBoth().post(ApiRoutes.transfers.dispatch(transfer.id))).status).toBe(OK)

      const response = await asBoth().post(ApiRoutes.transfers.cancel(transfer.id))

      expect(response.status).toBe(OK)
      expect(await onHand(mine, ctx.warehouseA.id)).toBe(STOCK)
      expect(await onHand(theirs, ctx.warehouseA.id)).toBe(STOCK)
    })

    it('is refused to someone who may not move the units of one of its stores, and nothing moves', async () => {
      const { mine, theirs, transfer } = await mixedTransfer()

      const response = await asHalf().post(ApiRoutes.transfers.dispatch(transfer.id))

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH)
      expect(await onHand(mine, ctx.warehouseA.id)).toBe(STOCK)
      expect(await onHand(theirs, ctx.warehouseA.id)).toBe(STOCK)
      const row = await owner.stockTransfer.findUniqueOrThrow({ where: { id: transfer.id } })
      expect(row.status).toBe(TransferStatus.DRAFT)
    })

    it('shows the person who belongs to both stores the lines of both', async () => {
      const { transfer } = await mixedTransfer()

      const response = await asBoth().get(ApiRoutes.transfers.byId(transfer.id))

      expect(response.status).toBe(OK)
      expect((response.body as { lines: unknown[] }).lines).toHaveLength(2)
    })
  })

  describe('a count', () => {
    it('is applied to the stock of BOTH stores, or to none', async () => {
      const { mine, theirs, count } = await mixedCount()

      const response = await asBoth().post(ApiRoutes.counts.apply(count.id))

      expect(response.status).toBe(OK)
      expect(await onHand(mine, ctx.warehouseA.id)).toBe(STOCK + 3)
      expect(await onHand(theirs, ctx.warehouseA.id)).toBe(STOCK - 3)
      const row = await owner.stockCount.findUniqueOrThrow({ where: { id: count.id } })
      expect(row.status).toBe(CountStatus.APPLIED)
      expect(
        await owner.inventoryMovement.count({
          where: { referenceType: InventoryReferenceType.COUNT, referenceId: count.id }
        })
      ).toBe(2)
    })

    it('is refused to someone who may not apply counts in one of its stores, and nothing moves', async () => {
      const { mine, theirs, count } = await mixedCount()

      const response = await asHalf().post(ApiRoutes.counts.apply(count.id))

      expect(response.status).toBe(FORBIDDEN)
      expect(errorOf(response).code).toBe(ErrorCodes.INVENTORY_COUNT_STORES_NOT_ALLOWED)
      expect(await onHand(mine, ctx.warehouseA.id)).toBe(STOCK)
      expect(await onHand(theirs, ctx.warehouseA.id)).toBe(STOCK)
      const row = await owner.stockCount.findUniqueOrThrow({ where: { id: count.id } })
      expect(row.status).toBe(CountStatus.REVIEW)
    })
  })

  describe('the wider context does not widen who may do what', () => {
    it('shows someone with a transfer permission in store A only the lines of store A, in a transfer of both', async () => {
      const { mine, transfer } = await mixedTransfer()

      const response = await asHalf().get(ApiRoutes.transfers.byId(transfer.id))

      expect(response.status).toBe(OK)
      const lines = (response.body as { lines: { storeId: string; productId: string }[] }).lines
      expect(lines.map(line => line.productId)).toEqual([mine.productId])
      expect(lines.every(line => line.storeId === ctx.storeA.id)).toBe(true)
    })

    it('does not let them edit or cancel a transfer made only of the lines of the store they hold no permission in', async () => {
      const theirs = await stocked(ctx.storeA2.id, ctx.warehouseA.id)
      const made = await owner.stockTransfer.create({
        data: {
          organizationId: ctx.orgA.id,
          number: uniqueTransferNumber(),
          fromWarehouseId: ctx.warehouseA.id,
          toWarehouseId: shared.id,
          status: TransferStatus.DRAFT,
          createdBy: ctx.adminA2.id,
          note: 'private to store A2',
          lines: { create: [{ storeId: theirs.storeId, productId: theirs.productId, quantity: 1 }] }
        },
        select: { id: true }
      })

      const edit = await asHalf().patch(ApiRoutes.transfers.byId(made.id)).send({ note: 'mine' })
      const cancel = await asHalf().post(ApiRoutes.transfers.cancel(made.id))

      expect(edit.status).toBe(NOT_FOUND)
      expect(cancel.status).toBe(NOT_FOUND)
      const row = await owner.stockTransfer.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.note).toBe('private to store A2')
      expect(row.status).toBe(TransferStatus.DRAFT)
    })

    it('ignores any list of stores, or of organizations, that the request carries', async () => {
      const foreign = await owner.stockTransfer.create({
        data: {
          organizationId: ctx.orgB.id,
          number: uniqueTransferNumber(),
          fromWarehouseId: ctx.warehouseB.id,
          toWarehouseId: (await createWarehouse(owner, { organizationId: ctx.orgB.id })).id,
          status: TransferStatus.DRAFT,
          createdBy: ctx.adminB.id
        },
        select: { id: true }
      })

      const response = await asBoth()
        .get(ApiRoutes.transfers.byId(foreign.id))
        .query({ storeIds: ctx.storeB.id, storeId: ctx.storeB.id, organizationId: ctx.orgB.id })
      const listed = await asBoth()
        .get(ApiRoutes.transfers.list)
        .query({ storeIds: ctx.storeB.id, organizationId: ctx.orgB.id, limit: 100 })

      expect(response.status).toBe(NOT_FOUND)
      const ids = (listed.body as { data: { id: string }[] }).data.map(row => row.id)
      expect(ids).not.toContain(foreign.id)
    })
  })

  describe('the rest of the organization', () => {
    it('does not show a transfer made only of the lines of a sibling store, header included', async () => {
      const theirs = await stocked(ctx.storeA2.id, ctx.warehouseA.id)
      const made = await owner.stockTransfer.create({
        data: {
          organizationId: ctx.orgA.id,
          number: uniqueTransferNumber(),
          fromWarehouseId: ctx.warehouseA.id,
          toWarehouseId: shared.id,
          status: TransferStatus.DRAFT,
          createdBy: ctx.adminA2.id,
          note: 'private to store A2',
          lines: { create: [{ storeId: theirs.storeId, productId: theirs.productId, quantity: 1 }] }
        },
        select: { id: true }
      })

      const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.transfers.byId(made.id))

      expect(response.status).toBe(NOT_FOUND)
    })

    it('does not switch off a warehouse that holds the units of a sibling store', async () => {
      const warehouse = await createWarehouse(owner, { organizationId: ctx.orgA.id })
      for (const storeId of [ctx.storeA.id, ctx.storeA2.id]) {
        await linkWarehouse(owner, {
          organizationId: ctx.orgA.id,
          storeId,
          warehouseId: warehouse.id
        })
      }
      await stocked(ctx.storeA2.id, warehouse.id)

      const response = await api(app, ctx.adminA, ctx.storeA)
        .patch(ApiRoutes.warehouses.byId(warehouse.id))
        .send({ active: false })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_HAS_STOCK)
      expect(
        (await owner.warehouse.findUniqueOrThrow({ where: { id: warehouse.id } })).active
      ).toBe(true)
    })
  })
})
