import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import {
  BulkLabelJobStatus,
  CarrierId,
  CarrierConnectionStatus,
  CarrierReportableStatuses,
  CarrierStatusMappingSource,
  CodStatus,
  GuideRefundStatus,
  OrderMessageKind,
  OrderReturnCondition,
  OrderReturnReasons,
  OrderReturnStatus,
  OrderReturnType,
  PickupStatus,
  ShipmentEventSource,
  ShipmentKind,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// What the database itself guarantees about the shipping tables (TDD_17 §2, §4.17) before any service writes to them
// (Step 4.8 PR B1): the rules the tenancy of shipments stands on, so that a bug of a service cannot break them. The
// routes that read and write these tables, and their cases in tenant-isolation.spec, arrive with Steps 4.8 to 4.12;
// until then the models are listed in scripts/isolation-exemptions.ts and this suite is their isolation proof.
describe('The shipping tables', () => {
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

  // What the database says when it refuses: the name of the constraint, or the text of the trigger, is in the message
  const refused = (statement: Promise<unknown>, constraint: string | RegExp) =>
    expect(statement).rejects.toThrow(constraint)

  const connect = (storeId: string, over: Record<string, unknown> = {}) =>
    owner.carrierConnection.create({
      data: {
        storeId,
        carrierId: CarrierId.LOCAL,
        displayName: `conn-${randomUUID().slice(0, 8)}`,
        ...over
      }
    })
  const ship = (
    storeId: string,
    orderId: string,
    connectionId: string,
    over: Record<string, unknown> = {}
  ) =>
    owner.shipment.create({
      data: {
        storeId,
        orderId,
        connectionId,
        serviceCode: 'standard',
        shippingPayer: ShippingPayer.SENDER,
        currency: 'USD',
        idempotencyKey: randomUUID(),
        createdBy: 'system',
        ...over
      }
    })
  const pickupOf = (storeId: string, connectionId: string, over: Record<string, unknown> = {}) =>
    owner.pickupRequest.create({
      data: {
        storeId,
        connectionId,
        pickupDate: new Date('2026-12-01'),
        requestedBy: 'system',
        ...over
      }
    })
  const returnOf = (storeId: string, orderId: string, over: Record<string, unknown> = {}) =>
    owner.orderReturn.create({
      data: {
        storeId,
        orderId,
        type: OrderReturnType.REFUND,
        reason: OrderReturnReasons.DEFECTIVE,
        shippingPayer: ShippingPayer.SENDER,
        createdBy: 'system',
        ...over
      }
    })

  describe('what hangs from a carrier connection', () => {
    it('is refused when it names a connection of another store, even of the same organization', async () => {
      const mine = await connect(ctx.storeA.id)
      const sibling = await connect(ctx.storeA2.id)
      const foreign = await connect(ctx.storeB.id)
      for (const other of [sibling, foreign]) {
        await refused(
          owner.carrierService.create({
            data: { storeId: ctx.storeA.id, connectionId: other.id, code: 'x', label: 'X' }
          }),
          /carrier_services_store_id_connection_id_fkey/
        )
        await refused(
          owner.guideSequence.create({
            data: { storeId: ctx.storeA.id, connectionId: other.id, prefix: 'JM' }
          }),
          /guide_sequences_store_id_connection_id_fkey/
        )
        await refused(
          owner.carrierStatusMapping.create({
            data: { storeId: ctx.storeA.id, connectionId: other.id, providerCode: 'x' }
          }),
          /carrier_status_mappings_store_id_connection_id_fkey/
        )
        await refused(
          owner.carrierUnmappedStatus.create({
            data: {
              storeId: ctx.storeA.id,
              connectionId: other.id,
              providerCode: 'x',
              sampleRawStatus: 'X'
            }
          }),
          /carrier_unmapped_statuses_store_id_connection_id_fkey/
        )
        await refused(
          pickupOf(ctx.storeA.id, other.id),
          /pickup_requests_store_id_connection_id_fkey/
        )
        const order = await createOrder(owner, { storeId: ctx.storeA.id })
        await refused(
          ship(ctx.storeA.id, order.id, other.id),
          /shipments_store_id_connection_id_fkey/
        )
      }
      // And the same rows with the connection of their own store are fine
      await owner.carrierService.create({
        data: { storeId: ctx.storeA.id, connectionId: mine.id, code: 'x', label: 'X' }
      })
      await owner.guideSequence.create({
        data: { storeId: ctx.storeA.id, connectionId: mine.id, prefix: 'JM' }
      })
    })

    it('goes with the connection when it is deleted, unless a shipment or a pickup uses it', async () => {
      const connection = await connect(ctx.storeA.id)
      await owner.carrierService.create({
        data: { storeId: ctx.storeA.id, connectionId: connection.id, code: 'x', label: 'X' }
      })
      await owner.guideSequence.create({
        data: { storeId: ctx.storeA.id, connectionId: connection.id, prefix: 'JM' }
      })
      await owner.carrierStatusMapping.create({
        data: { storeId: ctx.storeA.id, connectionId: connection.id, providerCode: 'x' }
      })
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const shipment = await ship(ctx.storeA.id, order.id, connection.id)
      await refused(
        owner.carrierConnection.delete({ where: { id: connection.id } }),
        /foreign key/i
      )
      await owner.shipment.delete({ where: { id: shipment.id } })
      await owner.carrierConnection.delete({ where: { id: connection.id } })
      expect(await owner.carrierService.count({ where: { connectionId: connection.id } })).toBe(0)
      expect(await owner.guideSequence.count({ where: { connectionId: connection.id } })).toBe(0)
      expect(
        await owner.carrierStatusMapping.count({ where: { connectionId: connection.id } })
      ).toBe(0)
    })

    it('has a name, status and fee range of its own, and a local one holds no secret', async () => {
      await connect(ctx.storeA.id, { displayName: 'twin' })
      await refused(connect(ctx.storeA.id, { displayName: 'twin' }), /Unique constraint/)
      // The same name in another store is another connection
      await connect(ctx.storeA2.id, { displayName: 'twin' })
      await refused(connect(ctx.storeA.id, { status: 'paused' }), /chk_carrier_connections_status/)
      await refused(
        connect(ctx.storeA.id, { credentials: Buffer.from('x') }),
        /chk_carrier_connections_local_credentials/
      )
      await connect(ctx.storeA.id, { carrierId: CarrierId.FORZA, credentials: Buffer.from('x') })
      const fee = (
        minShippingFeeCents: number | null,
        defaultShippingFeeCents: number | null,
        maxShippingFeeCents: number | null
      ) =>
        connect(ctx.storeA.id, {
          minShippingFeeCents,
          defaultShippingFeeCents,
          maxShippingFeeCents
        })
      await fee(100, 300, 500)
      await fee(null, 300, null)
      await fee(null, null, null)
      await refused(fee(400, 300, 500), /chk_carrier_connections_fee/)
      await refused(fee(100, 600, 500), /chk_carrier_connections_fee/)
      await refused(fee(600, null, 500), /chk_carrier_connections_fee/)
      await refused(fee(null, -1, null), /chk_carrier_connections_fee/)
      await refused(
        connect(ctx.storeA.id, { autoPickup: true }),
        /chk_carrier_connections_auto_pickup/
      )
      await refused(
        connect(ctx.storeA.id, { autoPickup: true, autoPickupTime: '08:00' }),
        /chk_carrier_connections_auto_pickup/
      )
      await connect(ctx.storeA.id, {
        pickupEnabled: true,
        autoPickup: true,
        autoPickupTime: '08:00'
      })
      await refused(
        connect(ctx.storeA.id, { pickupEnabled: true, pickupDays: [] }),
        /chk_carrier_connections_pickup_enabled/
      )
      await refused(
        connect(ctx.storeA.id, { pickupCutoffTime: '25:00' }),
        /chk_carrier_connections_times/
      )
      await refused(
        connect(ctx.storeA.id, { pickupDays: [0, 8] }),
        /chk_carrier_connections_pickup_days/
      )
      await refused(
        connect(ctx.storeA.id, { maxDeliveryAttempts: 0 }),
        /chk_carrier_connections_counts/
      )
    })

    it('keeps one guide sequence per connection that never goes below one', async () => {
      const connection = await connect(ctx.storeA.id)
      const sequence = { storeId: ctx.storeA.id, connectionId: connection.id }
      await refused(
        owner.guideSequence.create({ data: { ...sequence, prefix: 'bad prefix' } }),
        /chk_guide_sequences_prefix/
      )
      await refused(
        owner.guideSequence.create({ data: { ...sequence, prefix: 'JM', nextValue: 0 } }),
        /chk_guide_sequences_next/
      )
      await owner.guideSequence.create({ data: { ...sequence, prefix: 'JM' } })
      await refused(
        owner.guideSequence.create({ data: { ...sequence, prefix: 'JN' } }),
        /Unique constraint/
      )
    })

    it('maps a provider code once per connection, to a status a carrier can report', async () => {
      const connection = await connect(ctx.storeA.id)
      const mapping = (status: string | null, providerCode = 'in_route') =>
        owner.carrierStatusMapping.create({
          data: { storeId: ctx.storeA.id, connectionId: connection.id, providerCode, status }
        })
      await mapping(ShipmentStatus.IN_TRANSIT)
      await refused(mapping(ShipmentStatus.DELIVERED), /Unique constraint/)
      await mapping(null, 'ignored') // ignore on purpose
      await refused(mapping(ShipmentStatus.CREATING, 'a'), /chk_carrier_status_mappings_status/)
      await refused(
        mapping(ShipmentStatus.REQUIRES_REVIEW, 'b'),
        /chk_carrier_status_mappings_status/
      )
      await refused(
        owner.carrierStatusMapping.create({
          data: {
            storeId: ctx.storeA.id,
            connectionId: connection.id,
            providerCode: 'c',
            source: 'x'
          }
        }),
        /chk_carrier_status_mappings_source/
      )
      const unmapped = {
        storeId: ctx.storeA.id,
        connectionId: connection.id,
        providerCode: 'q',
        sampleRawStatus: 'Q'
      }
      await owner.carrierUnmappedStatus.create({ data: unmapped })
      await refused(owner.carrierUnmappedStatus.create({ data: unmapped }), /Unique constraint/)
    })
  })

  describe('a shipment', () => {
    it('is refused when its order, warehouse, pickup or return belongs to another store', async () => {
      const connection = await connect(ctx.storeA.id)
      const orderA = await createOrder(owner, { storeId: ctx.storeA.id })
      const orderOfSibling = await createOrder(owner, { storeId: ctx.storeA2.id })
      const orderOfB = await createOrder(owner, { storeId: ctx.storeB.id })
      for (const order of [orderOfSibling, orderOfB]) {
        await refused(
          ship(ctx.storeA.id, order.id, connection.id),
          /not an order of the store of the shipment/
        )
      }
      // The origin warehouse is one of the organization of the store
      await refused(
        ship(ctx.storeA.id, orderA.id, connection.id, { originWarehouseId: ctx.warehouseB.id }),
        /not a warehouse of the organization of its store/
      )
      await ship(ctx.storeA.id, orderA.id, connection.id, { originWarehouseId: ctx.warehouseA.id })
      // A pickup of another store (even one of the same organization)
      const otherConnection = await connect(ctx.storeA2.id)
      const pickupOfSibling = await pickupOf(ctx.storeA2.id, otherConnection.id)
      const orderA2 = await createOrder(owner, { storeId: ctx.storeA.id })
      await refused(
        ship(ctx.storeA.id, orderA2.id, connection.id, { pickupId: pickupOfSibling.id }),
        /shipments_store_id_pickup_id_fkey/
      )
      const pickup = await pickupOf(ctx.storeA.id, connection.id)
      await ship(ctx.storeA.id, orderA2.id, connection.id, { pickupId: pickup.id })
      // A return of another order, or of another store
      const orderA3 = await createOrder(owner, { storeId: ctx.storeA.id })
      const returnOfA2 = await returnOf(ctx.storeA.id, orderA2.id)
      await refused(
        ship(ctx.storeA.id, orderA3.id, connection.id, {
          kind: ShipmentKind.RETURN,
          returnId: returnOfA2.id
        }),
        /not a return of the order of the shipment/
      )
      const returnOfSibling = await returnOf(ctx.storeA2.id, orderOfSibling.id)
      await refused(
        ship(ctx.storeA.id, orderOfSibling.id, connection.id, {
          kind: ShipmentKind.RETURN,
          returnId: returnOfSibling.id
        }),
        /not an order of the store of the shipment/
      )
    })

    it('never moves to another store, order, connection or kind', async () => {
      const connection = await connect(ctx.storeA.id)
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const other = await createOrder(owner, { storeId: ctx.storeA.id })
      const shipment = await ship(ctx.storeA.id, order.id, connection.id)
      const move = (data: Record<string, unknown>) =>
        owner.shipment.update({ where: { id: shipment.id }, data })
      await refused(move({ orderId: other.id }), /never changed/)
      await refused(move({ connectionId: (await connect(ctx.storeA.id)).id }), /never changed/)
      await refused(move({ storeId: ctx.storeA2.id }), /never changed|not an order of the store/)
      // The warehouse it leaves from may be set once (it was unknown at creation), never changed after
      await move({ originWarehouseId: ctx.warehouseA.id })
      await refused(move({ originWarehouseId: ctx.warehouseASecond.id }), /never changed/)
      await refused(move({ originWarehouseId: null }), /never changed/)
      const withWarehouse = await ship(ctx.storeA.id, other.id, connection.id, {
        originWarehouseId: ctx.warehouseA.id
      })
      await refused(
        owner.shipment.update({
          where: { id: withWarehouse.id },
          data: { originWarehouseId: ctx.warehouseASecond.id }
        }),
        /never changed/
      )
      await move({ status: ShipmentStatus.LABEL_CREATED, guideNumber: 'G-1' })
    })

    it('allows one active outbound guide per order and warehouse, and a new one after a cancel or a failure', async () => {
      const connection = await connect(ctx.storeA.id)
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const first = await ship(ctx.storeA.id, order.id, connection.id)
      // No warehouse is still one: NULLS NOT DISTINCT
      await refused(ship(ctx.storeA.id, order.id, connection.id), /Unique constraint/)
      // Another warehouse of the same order is a split shipment (TDD_16 §4.1)
      await ship(ctx.storeA.id, order.id, connection.id, { originWarehouseId: ctx.warehouseA.id })
      await refused(
        ship(ctx.storeA.id, order.id, connection.id, { originWarehouseId: ctx.warehouseA.id }),
        /Unique constraint/
      )
      // While a cancel is pending or failed the index still refuses the new guide (TDD_17 §4.8)
      for (const status of [ShipmentStatus.CANCEL_PENDING, ShipmentStatus.CANCEL_FAILED]) {
        await owner.shipment.update({ where: { id: first.id }, data: { status } })
        await refused(ship(ctx.storeA.id, order.id, connection.id), /Unique constraint/)
      }
      await owner.shipment.update({
        where: { id: first.id },
        data: { status: ShipmentStatus.CANCELLED }
      })
      const second = await ship(ctx.storeA.id, order.id, connection.id)
      await owner.shipment.update({
        where: { id: second.id },
        data: { status: ShipmentStatus.FAILED }
      })
      await ship(ctx.storeA.id, order.id, connection.id)
    })

    it('has a guide number that is unique in its connection and an idempotency key that is unique', async () => {
      const connection = await connect(ctx.storeA.id)
      const other = await connect(ctx.storeA.id)
      const [one, two, three] = await Promise.all(
        [0, 1, 2].map(() => createOrder(owner, { storeId: ctx.storeA.id }))
      )
      await ship(ctx.storeA.id, one?.id ?? '', connection.id, { guideNumber: 'JM-1' })
      await refused(
        ship(ctx.storeA.id, two?.id ?? '', connection.id, { guideNumber: 'JM-1' }),
        /Unique constraint/
      )
      // The same number at another carrier is another guide, and a shipment with no guide yet is not a number
      await ship(ctx.storeA.id, two?.id ?? '', other.id, { guideNumber: 'JM-1' })
      const key = randomUUID()
      await ship(ctx.storeA.id, three?.id ?? '', connection.id, { idempotencyKey: key })
      await refused(
        ship(ctx.storeA.id, three?.id ?? '', other.id, {
          idempotencyKey: key,
          originWarehouseId: ctx.warehouseA.id
        }),
        /Unique constraint/
      )
      // The key is unique per store: another store may use the same one, and learns nothing about this one
      const sibling = await connect(ctx.storeA2.id)
      const siblingOrder = await createOrder(owner, { storeId: ctx.storeA2.id })
      await ship(ctx.storeA2.id, siblingOrder.id, sibling.id, { idempotencyKey: key })
    })

    it('keeps its money, counts, cash-on-delivery state and return link consistent', async () => {
      const connection = await connect(ctx.storeA.id)
      const order = async () => (await createOrder(owner, { storeId: ctx.storeA.id })).id
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { status: 'shipped' }),
        /chk_shipments_status/
      )
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { shippingPayer: 'me' }),
        /chk_shipments_payer/
      )
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { packageCount: 0 }),
        /chk_shipments_counts/
      )
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { weightGrams: 0 }),
        /chk_shipments_counts/
      )
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { currency: 'usd' }),
        /chk_shipments_text/
      )
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { carrierCostCents: -1 }),
        /chk_shipments_amounts/
      )
      // Cash on delivery: an amount and a state go together
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { codAmountCents: 1500 }),
        /chk_shipments_cod_pair/
      )
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { codStatus: CodStatus.NOT_DELIVERED }),
        /chk_shipments_cod_pair/
      )
      await ship(ctx.storeA.id, await order(), connection.id, {
        codAmountCents: 1500,
        codStatus: CodStatus.NOT_DELIVERED
      })
      // A return shipment names its return, and only a return shipment does
      await refused(
        ship(ctx.storeA.id, await order(), connection.id, { kind: ShipmentKind.RETURN }),
        /chk_shipments_return_pair/
      )
    })
  })

  describe('the history of a shipment', () => {
    it('is refused for a shipment of another store and stores a provider event once', async () => {
      const connection = await connect(ctx.storeA.id)
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const shipment = await ship(ctx.storeA.id, order.id, connection.id)
      const event = (storeId: string, over: Record<string, unknown> = {}) =>
        owner.shipmentEvent.create({
          data: {
            storeId,
            shipmentId: shipment.id,
            occurredAt: new Date(),
            source: ShipmentEventSource.WEBHOOK,
            ...over
          }
        })
      await refused(event(ctx.storeA2.id), /shipment_events_store_id_shipment_id_fkey/)
      await refused(event(ctx.storeB.id), /shipment_events_store_id_shipment_id_fkey/)
      await event(ctx.storeA.id, { providerEventId: 'e-1', status: ShipmentStatus.IN_TRANSIT })
      await refused(event(ctx.storeA.id, { providerEventId: 'e-1' }), /Unique constraint/)
      // Events with no provider id are never duplicates of each other, and an unmapped status has a null status
      await event(ctx.storeA.id)
      await event(ctx.storeA.id, { rawStatus: 'WEIRD', status: null })
      await refused(event(ctx.storeA.id, { source: 'carrier' }), /chk_shipment_events_source/)
      await refused(event(ctx.storeA.id, { status: 'lost' }), /chk_shipment_events_status/)
      // They go with the shipment
      await owner.shipment.delete({ where: { id: shipment.id } })
      expect(await owner.shipmentEvent.count({ where: { shipmentId: shipment.id } })).toBe(0)
    })
  })

  describe('a pickup', () => {
    it('has a window of two ordered times or none, and a count that is never negative', async () => {
      const connection = await connect(ctx.storeA.id)
      await pickupOf(ctx.storeA.id, connection.id, { windowStart: '09:00', windowEnd: '12:30' })
      // Several pickups on one day are allowed (a pickup-bound carrier needs them)
      await pickupOf(ctx.storeA.id, connection.id)
      await pickupOf(ctx.storeA.id, connection.id)
      await refused(
        pickupOf(ctx.storeA.id, connection.id, { windowStart: '09:00' }),
        /chk_pickup_requests_window/
      )
      await refused(
        pickupOf(ctx.storeA.id, connection.id, { windowStart: '12:00', windowEnd: '09:00' }),
        /chk_pickup_requests_window/
      )
      await refused(
        pickupOf(ctx.storeA.id, connection.id, { packageCount: -1 }),
        /chk_pickup_requests_counts/
      )
      await refused(
        pickupOf(ctx.storeA.id, connection.id, { status: 'done' }),
        /chk_pickup_requests_status/
      )
    })
  })

  describe('a bulk label job and an order message template', () => {
    it('counts what it did and has finished only when it is no longer queued or running', async () => {
      const job = (over: Record<string, unknown>) =>
        owner.bulkLabelJob.create({
          data: {
            storeId: ctx.storeA.id,
            orderIds: ['a', 'b'],
            total: 2,
            requestedBy: 'u',
            ...over
          }
        })
      await job({})
      // A list column is nullable in SQL: a null list passes no check
      await refused(
        owner.$executeRaw`INSERT INTO bulk_label_jobs (id, store_id, order_ids, total, requested_by) VALUES (${randomUUID()}, ${ctx.storeA.id}, NULL, 1, 'u')`,
        /chk_bulk_label_jobs_counts/
      )
      await refused(
        owner.$executeRaw`INSERT INTO carrier_connections (id, store_id, carrier_id, display_name, pickup_days, updated_at) VALUES (${randomUUID()}, ${ctx.storeA.id}, ${CarrierId.LOCAL}, 'nulldays', NULL, now())`,
        /chk_carrier_connections_pickup_days/
      )
      await job({ status: BulkLabelJobStatus.COMPLETED, succeeded: 2, finishedAt: new Date() })
      await refused(job({ total: 3 }), /chk_bulk_label_jobs_counts/)
      await refused(job({ succeeded: 2, failed: 1 }), /chk_bulk_label_jobs_counts/)
      await refused(job({ status: BulkLabelJobStatus.COMPLETED }), /chk_bulk_label_jobs_finished/)
      await refused(job({ finishedAt: new Date() }), /chk_bulk_label_jobs_finished/)
      // A finished job accounted for every order, and "with errors" means some failed
      const finished = { finishedAt: new Date() }
      await refused(
        job({ status: BulkLabelJobStatus.COMPLETED, succeeded: 1, ...finished }),
        /chk_bulk_label_jobs_outcome/
      )
      await refused(
        job({ status: BulkLabelJobStatus.COMPLETED, succeeded: 1, failed: 1, ...finished }),
        /chk_bulk_label_jobs_outcome/
      )
      await refused(
        job({ status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS, succeeded: 2, ...finished }),
        /chk_bulk_label_jobs_outcome/
      )
      await job({
        status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
        succeeded: 1,
        failed: 1,
        ...finished
      })
    })

    it('has one template per store, kind and locale', async () => {
      const template = (storeId: string, over: Record<string, unknown> = {}) =>
        owner.orderMessageTemplate.create({
          data: {
            storeId,
            kind: OrderMessageKind.ORDER_SHIPPED,
            locale: 'es',
            body: 'Hola {{customerName}}',
            ...over
          }
        })
      await template(ctx.storeA.id)
      await refused(template(ctx.storeA.id), /Unique constraint/)
      await template(ctx.storeA2.id)
      await template(ctx.storeA.id, { locale: 'en' })
      await refused(
        template(ctx.storeA.id, { kind: OrderMessageKind.ORDER_CANCELLED, body: ' ' }),
        /chk_order_message_templates_text/
      )
    })
  })

  describe('a return and its lines', () => {
    it('is refused for an order, replacement, shipment or item of another store or order', async () => {
      const connection = await connect(ctx.storeA.id)
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const replacement = await createOrder(owner, { storeId: ctx.storeA.id })
      const orderOfSibling = await createOrder(owner, { storeId: ctx.storeA2.id })
      await refused(
        returnOf(ctx.storeA.id, orderOfSibling.id),
        /not an order of the store of the return/
      )
      await refused(
        returnOf(ctx.storeA.id, order.id, {
          type: OrderReturnType.EXCHANGE,
          replacementOrderId: orderOfSibling.id
        }),
        /replacement order of a return is not an order of the store/
      )
      // Only an exchange has a replacement, and it is another order
      await refused(
        returnOf(ctx.storeA.id, order.id, { replacementOrderId: replacement.id }),
        /chk_order_returns_replacement/
      )
      await refused(
        returnOf(ctx.storeA.id, order.id, {
          type: OrderReturnType.EXCHANGE,
          replacementOrderId: order.id
        }),
        /chk_order_returns_replacement/
      )
      const exchange = await returnOf(ctx.storeA.id, order.id, {
        type: OrderReturnType.EXCHANGE,
        replacementOrderId: replacement.id
      })
      // The return shipment is a return-kind shipment made for this return
      const outbound = await ship(ctx.storeA.id, order.id, connection.id)
      await refused(
        owner.orderReturn.update({
          where: { id: exchange.id },
          data: { returnShipmentId: outbound.id }
        }),
        /not a return shipment made for it/
      )
      const back = await ship(ctx.storeA.id, order.id, connection.id, {
        kind: ShipmentKind.RETURN,
        returnId: exchange.id
      })
      await owner.orderReturn.update({
        where: { id: exchange.id },
        data: { returnShipmentId: back.id }
      })
      // Neither moves to another order, store or type afterwards
      await refused(
        owner.orderReturn.update({ where: { id: exchange.id }, data: { orderId: replacement.id } }),
        /never changed/
      )
      await refused(
        owner.orderReturn.update({
          where: { id: exchange.id },
          data: { type: OrderReturnType.REFUND }
        }),
        /never changed/
      )

      // The lines
      const line = (returnId: string, orderItemId: string, over: Record<string, unknown> = {}) =>
        owner.orderReturnLine.create({
          data: { storeId: ctx.storeA.id, returnId, orderItemId, quantity: 1, ...over }
        })
      await refused(
        line(exchange.id, orderOfSibling.itemId),
        /not an item of the order that is returned/
      )
      await refused(
        line(exchange.id, replacement.itemId),
        /not an item of the order that is returned/
      )
      await refused(
        line(exchange.id, order.itemId, { quantity: 0 }),
        /chk_order_return_lines_quantity/
      )
      await refused(
        line(exchange.id, order.itemId, { condition: 'broken' }),
        /chk_order_return_lines_condition/
      )
      await refused(
        line(exchange.id, order.itemId, { restockWarehouseId: ctx.warehouseB.id }),
        /not a warehouse of the organization of its store/
      )
      await refused(
        owner.orderReturnLine.create({
          data: {
            storeId: ctx.storeA2.id,
            returnId: exchange.id,
            orderItemId: order.itemId,
            quantity: 1
          }
        }),
        /order_return_lines_store_id_return_id_fkey/
      )
      await line(exchange.id, order.itemId, {
        condition: OrderReturnCondition.RESELLABLE,
        restockWarehouseId: ctx.warehouseA.id
      })
      await refused(line(exchange.id, order.itemId), /Unique constraint/)
      // The lines go with their return once the shipment link is cut (the shipment and the return restrict each other)
      await owner.orderReturn.update({
        where: { id: exchange.id },
        data: { returnShipmentId: null }
      })
      await owner.shipment.delete({ where: { id: back.id } })
      await owner.orderReturn.delete({ where: { id: exchange.id } })
      expect(await owner.orderReturnLine.count({ where: { returnId: exchange.id } })).toBe(0)
    })
  })

  describe('the sets of values of the columns that hold a state', () => {
    // A value added to an enum and not to the CHECK of its column (or the other way round) would be refused by the
    // database in production and pass every unit test, so the two are compared here
    const valuesOf = async (constraint: string): Promise<string[]> => {
      const rows = await owner.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ${constraint}`
      expect(rows).toHaveLength(1)
      return [
        ...new Set(
          [...(rows[0]?.definition ?? '').matchAll(/'([a-z_]+)'::text/g)].map(m => m[1] ?? '')
        )
      ].sort()
    }
    const sorted = (values: readonly string[]) => [...values].sort()

    it.each([
      ['chk_carrier_connections_status', Object.values(CarrierConnectionStatus)],
      ['chk_carrier_connections_payer', Object.values(ShippingPayer)],
      ['chk_shipments_kind', Object.values(ShipmentKind)],
      ['chk_shipments_status', Object.values(ShipmentStatus)],
      ['chk_shipments_payer', Object.values(ShippingPayer)],
      ['chk_shipments_refund_status', Object.values(GuideRefundStatus)],
      ['chk_shipments_cod_status', Object.values(CodStatus)],
      ['chk_shipment_events_source', Object.values(ShipmentEventSource)],
      ['chk_shipment_events_status', Object.values(ShipmentStatus)],
      ['chk_carrier_status_mappings_source', Object.values(CarrierStatusMappingSource)],
      ['chk_carrier_status_mappings_status', CarrierReportableStatuses],
      ['chk_pickup_requests_status', Object.values(PickupStatus)],
      ['chk_bulk_label_jobs_status', Object.values(BulkLabelJobStatus)],
      ['chk_order_returns_type', Object.values(OrderReturnType)],
      ['chk_order_returns_status', Object.values(OrderReturnStatus)],
      ['chk_order_returns_payer', Object.values(ShippingPayer)],
      ['chk_order_return_lines_condition', Object.values(OrderReturnCondition)]
    ] as Array<[string, readonly string[]]>)(
      '%s is the enum of its column',
      async (constraint, values) => {
        expect(await valuesOf(constraint)).toEqual(sorted(values))
      }
    )
  })
})
