import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FinanceEventKind,
  FinancePostingFailureReason,
  FinanceSourceType,
  InventoryMovementType,
  OrderStatus,
  PaymentStatus,
  ShipmentStatus,
  TransferShortageAction,
  TransferStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { JobNames, QueueNames } from '@platform/core/queues'

import { FinancePostingQueue } from '../../apps/api/src/modules/finance/finance-posting.queue'
import { createOrder, createTransfer } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const CREATED = 201

// The listener of the books hears the events of the domain AFTER the commit of the operation, outside any request: there is no tenant
// context open. With RLS_CONTEXT on and the policies enforced (the `rls-enforced` job of the CI) its database work must open the
// context of the organization of the event by itself. Each case emits the event the way a service does, from outside any context, and
// reads what the listener queued (one case per handler: E1, E2/E3, E4, E5, E6, E7, E8, E9 twice, E14, E15, E16). The two paths that read
// or write a row of the books (the lines of a closed transfer, the list of a source that could not be queued) fail if their context is
// taken away. `store.findUnique` of `organizationOf` needs none: `stores` has no row policy (neverPolicy, see the comment there).
describe('The listener of the automatic entries opens its own context (RLS phase 6, B3a)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let emitter: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    emitter = app.get(EventEmitter2)
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const system = { type: 'system', id: null } as const
  const queuedFor = (sourceId: string) =>
    queueOf(app, QueueNames.HEAVY_PROCESSING)
      .jobs.filter(
        job =>
          job.name === JobNames.POST_FINANCE_EVENT &&
          (job.data as { sourceId?: string }).sourceId === sourceId
      )
      .map(job => job.data as { organizationId: string; sourceType: string; kind: string })

  const expectQueued = (
    sourceId: string,
    kinds: readonly FinanceEventKind[],
    sourceType: FinanceSourceType
  ) => {
    const jobs = queuedFor(sourceId)
    expect(jobs.map(job => job.kind).sort()).toEqual([...kinds].sort())
    for (const job of jobs) {
      expect(job).toMatchObject({ organizationId: ctx.orgA.id, sourceType })
    }
  }

  const order = (id: string) => ({
    storeId: ctx.storeA.id,
    orderId: id,
    orderNumber: 'T-1',
    actor: system
  })

  it('E1: an order paid asks for the payment and the sale', async () => {
    const id = randomUUID()
    await emitter.emitAsync(Events.ORDER_PAYMENT_STATUS_CHANGED, {
      ...order(id),
      from: PaymentStatus.PENDING,
      to: PaymentStatus.COMPLETED
    })
    expectQueued(id, [FinanceEventKind.PAYMENT, FinanceEventKind.SALE], FinanceSourceType.ORDER)
  })

  it('E2 and E3: an order shipped or delivered asks for the shipping and the sale', async () => {
    const id = randomUUID()
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
      ...order(id),
      from: OrderStatus.CONFIRMED,
      to: OrderStatus.SHIPPED,
      notifyCustomer: null
    })
    expectQueued(id, [FinanceEventKind.SENT, FinanceEventKind.SALE], FinanceSourceType.ORDER)
  })

  it('E8: an order returned as a whole asks for its return entry', async () => {
    const id = randomUUID()
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
      ...order(id),
      from: OrderStatus.DELIVERED,
      to: OrderStatus.RETURNED,
      notifyCustomer: null
    })
    expectQueued(id, [FinanceEventKind.ORDER_RETURN], FinanceSourceType.ORDER)
  })

  it('E8 and E14: a return received, and its refund recorded', async () => {
    const received = randomUUID()
    await emitter.emitAsync(Events.RETURN_RECEIVED, { ...order(randomUUID()), returnId: received })
    expectQueued(received, [FinanceEventKind.RETURN_RESTOCK], FinanceSourceType.RETURN)
    const refunded = randomUUID()
    await emitter.emitAsync(Events.RETURN_REFUND_RECORDED, {
      ...order(randomUUID()),
      returnId: refunded
    })
    expectQueued(refunded, [FinanceEventKind.RETURN_REFUND], FinanceSourceType.RETURN)
  })

  it('E4: a guide delivered asks for the charges of the carrier', async () => {
    const id = randomUUID()
    await emitter.emitAsync(Events.SHIPMENT_STATUS_CHANGED, {
      storeId: ctx.storeA.id,
      shipmentId: id,
      orderId: randomUUID(),
      orderNumber: 'T-2',
      connectionId: randomUUID(),
      actor: system,
      from: ShipmentStatus.OUT_FOR_DELIVERY,
      to: ShipmentStatus.DELIVERED
    })
    expectQueued(id, [FinanceEventKind.CHARGES], FinanceSourceType.SHIPMENT)
  })

  it('E5, E6 and E7: a remittance confirmed, voided, and a difference written off', async () => {
    const confirmed = randomUUID()
    const base = { storeId: ctx.storeA.id, connectionId: randomUUID(), actor: system }
    await emitter.emitAsync(Events.REMITTANCE_CONFIRMED, { ...base, remittanceId: confirmed })
    expectQueued(confirmed, [FinanceEventKind.REMITTANCE_CONFIRM], FinanceSourceType.REMITTANCE)
    const voided = randomUUID()
    await emitter.emitAsync(Events.REMITTANCE_VOIDED, { ...base, remittanceId: voided })
    expectQueued(voided, [FinanceEventKind.REMITTANCE_VOID], FinanceSourceType.REMITTANCE)
    const shipment = randomUUID()
    await emitter.emitAsync(Events.REMITTANCE_DIFFERENCE_WRITTEN_OFF, {
      ...base,
      shipmentId: shipment
    })
    expectQueued(shipment, [FinanceEventKind.COD_WRITE_OFF], FinanceSourceType.SHIPMENT)
  })

  it('E15 and E16: a purchase of guides recorded, and voided', async () => {
    const base = { storeId: ctx.storeA.id, connectionId: randomUUID() }
    const bought = randomUUID()
    await emitter.emitAsync(Events.CARRIER_GUIDES_PURCHASED, { ...base, movementId: bought })
    expectQueued(
      bought,
      [FinanceEventKind.GUIDE_PURCHASE],
      FinanceSourceType.CARRIER_GUIDE_MOVEMENT
    )
    const voided = randomUUID()
    await emitter.emitAsync(Events.CARRIER_GUIDES_PURCHASE_VOIDED, { ...base, movementId: voided })
    expectQueued(
      voided,
      [FinanceEventKind.GUIDE_PURCHASE_VOID],
      FinanceSourceType.CARRIER_GUIDE_MOVEMENT
    )
  })

  it('E9: a stock adjustment asks for its entry, and a plain receipt does not', async () => {
    const moved = (type: InventoryMovementType, movementId: string) =>
      emitter.emitAsync(Events.INVENTORY_MOVED, {
        movementId,
        storeId: ctx.storeA.id,
        productId: randomUUID(),
        variantId: null,
        warehouseId: randomUUID(),
        type,
        quantity: 1
      })
    const adjusted = randomUUID()
    await moved(InventoryMovementType.ADJUSTMENT_IN, adjusted)
    expectQueued(adjusted, [FinanceEventKind.ADJUST], FinanceSourceType.INVENTORY_MOVEMENT)
    const received = randomUUID()
    await moved(InventoryMovementType.RECEIPT, received)
    expect(queuedFor(received)).toEqual([])
  })

  // The listener reads the lines of the closed transfer INSIDE the context of the organization: without it the policy hides them and
  // the write-off is never queued (the sweep of 4B.6b would find it later, which is why nothing else notices)
  it('E9: a transfer closed with a write-off line queues that line (read in the context of the organization)', async () => {
    const transfer = await createTransfer(owner, {
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      status: TransferStatus.RECEIVED
    })
    const lineId = transfer.lineId ?? ''
    expect(lineId).not.toBe('')
    await owner.stockTransferLine.update({
      where: { id: lineId },
      data: { shortageAction: TransferShortageAction.WRITE_OFF }
    })
    await emitter.emitAsync(Events.TRANSFER_RECEIVED, {
      organizationId: ctx.orgA.id,
      transferId: transfer.id,
      number: transfer.number,
      status: TransferStatus.RECEIVED,
      fromWarehouseId: randomUUID(),
      toWarehouseId: randomUUID(),
      storeIds: [ctx.storeA.id]
    })
    expectQueued(lineId, [FinanceEventKind.TRANSFER_WRITE_OFF], FinanceSourceType.TRANSFER_LINE)
  })

  // A source that could not be queued goes on the list of failures: that write needs the context of the organization too
  it('lists the source whose job could not be queued, in the context of the organization', async () => {
    const created = await createOrder(owner, { storeId: ctx.storeA.id })
    const queue = app.get(FinancePostingQueue)
    const failing = jest.spyOn(queue, 'enqueue').mockRejectedValue(new Error('redis is down'))
    try {
      await emitter.emitAsync(Events.ORDER_PAYMENT_STATUS_CHANGED, {
        ...order(created.id),
        from: PaymentStatus.PENDING,
        to: PaymentStatus.COMPLETED
      })
    } finally {
      failing.mockRestore()
    }
    const rows = await owner.financePostingFailure.findMany({
      where: { organizationId: ctx.orgA.id, sourceId: created.id }
    })
    expect(rows.map(row => row.eventKind).sort()).toEqual(
      [FinanceEventKind.PAYMENT, FinanceEventKind.SALE].sort()
    )
    for (const row of rows) {
      expect(row).toMatchObject({
        reason: FinancePostingFailureReason.NOT_QUEUED,
        resolvedAt: null
      })
    }
  })

  it('does nothing, and does not fail, for a store that no longer exists', async () => {
    const id = randomUUID()
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
      storeId: randomUUID(),
      orderId: id,
      orderNumber: 'T-3',
      actor: system,
      from: OrderStatus.CONFIRMED,
      to: OrderStatus.SHIPPED,
      notifyCustomer: null
    })
    expect(queuedFor(id)).toEqual([])
  })
})
