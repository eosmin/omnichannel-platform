import type { PinoLogger } from 'nestjs-pino'

import type { EventContext } from '@platform/core/database'
import {
  FinanceEventKind,
  FinanceSourceType,
  OrderStatus,
  ShipmentStatus
} from '@platform/core/domain'
import type { OrderStatusChangedPayload, ShipmentStatusChangedPayload } from '@platform/core/events'
import type { FinancePostingService } from '@platform/core/finance-ledger'

import { FinancePostingListener } from './finance-posting.listener'
import type { FinancePostingQueue } from './finance-posting.queue'

const ORG = 'org-1'
const STORE = 'store-1'

interface Queued {
  organizationId: string
  sourceType: string
  sourceId: string
  kind: string
}

function build(options: { organization?: string | null; queueFails?: boolean } = {}) {
  const queued: Queued[] = []
  const unposted: Queued[] = []
  const prisma = {
    client: {
      store: {
        findUnique: () =>
          Promise.resolve(
            options.organization === null ? null : { organizationId: options.organization ?? ORG }
          )
      }
    }
  }
  const logger = { setContext: () => undefined, error: () => undefined, warn: () => undefined }
  const queue = {
    enqueue: (job: Queued) => {
      if (options.queueFails === true) return Promise.reject(new Error('redis is down'))
      queued.push(job)
      return Promise.resolve()
    }
  }
  const posting = {
    markUnposted: (job: Queued) => {
      unposted.push(job)
      return Promise.resolve()
    }
  }
  const listener = new FinancePostingListener(
    prisma as never,
    {
      inOrganization: (_id: string, work: () => Promise<unknown>) => work()
    } as unknown as EventContext,
    logger as unknown as PinoLogger,
    queue as unknown as FinancePostingQueue,
    posting as unknown as FinancePostingService
  )
  return { listener, queued, unposted }
}

const shipmentPayload = (to: ShipmentStatus): ShipmentStatusChangedPayload => ({
  storeId: STORE,
  shipmentId: 'ship-1',
  orderId: 'order-1',
  orderNumber: '1001',
  connectionId: 'conn-1',
  actor: { type: 'system', id: null },
  from: ShipmentStatus.OUT_FOR_DELIVERY,
  to
})

describe('FinancePostingListener, the carrier events (E4 to E6)', () => {
  it('queues the charges of a guide when it is delivered, and nothing for another status', async () => {
    const { listener, queued } = build()
    await listener.onShipmentStatus(shipmentPayload(ShipmentStatus.IN_TRANSIT))
    await listener.onShipmentStatus(shipmentPayload(ShipmentStatus.RETURNED))
    expect(queued).toEqual([])
    await listener.onShipmentStatus(shipmentPayload(ShipmentStatus.DELIVERED))
    expect(queued).toMatchObject([
      {
        organizationId: ORG,
        sourceType: FinanceSourceType.SHIPMENT,
        sourceId: 'ship-1',
        kind: FinanceEventKind.CHARGES
      }
    ])
  })

  it('queues the confirmation and the voiding of a remittance, each as its own event of the remittance', async () => {
    const { listener, queued } = build()
    const payload = {
      storeId: STORE,
      remittanceId: 'rem-1',
      connectionId: 'conn-1',
      actor: { type: 'user' as const, id: 'user-1' }
    }
    await listener.onRemittanceConfirmed(payload)
    await listener.onRemittanceVoided(payload)
    expect(queued.map(job => [job.sourceType, job.sourceId, job.kind])).toEqual([
      [FinanceSourceType.REMITTANCE, 'rem-1', FinanceEventKind.REMITTANCE_CONFIRM],
      [FinanceSourceType.REMITTANCE, 'rem-1', FinanceEventKind.REMITTANCE_VOID]
    ])
  })

  it('queues the write-off of a difference as an event of the guide', async () => {
    const { listener, queued } = build()
    await listener.onDifferenceWrittenOff({
      storeId: STORE,
      shipmentId: 'ship-1',
      connectionId: 'conn-1',
      actor: { type: 'user', id: 'user-1' }
    })
    expect(queued).toMatchObject([
      {
        organizationId: ORG,
        sourceType: FinanceSourceType.SHIPMENT,
        sourceId: 'ship-1',
        kind: FinanceEventKind.COD_WRITE_OFF
      }
    ])
  })

  it('queues the purchase of guides and its void, each as an event of the movement of the ledger of guides (E15, E16)', async () => {
    const { listener, queued } = build()
    const payload = { storeId: STORE, connectionId: 'conn-1', movementId: 'mov-1' }
    await listener.onGuidesPurchased(payload)
    await listener.onGuidesPurchaseVoided({ ...payload, movementId: 'mov-2' })
    expect(queued).toMatchObject([
      {
        organizationId: ORG,
        sourceType: FinanceSourceType.CARRIER_GUIDE_MOVEMENT,
        sourceId: 'mov-1',
        kind: FinanceEventKind.GUIDE_PURCHASE
      },
      {
        organizationId: ORG,
        sourceType: FinanceSourceType.CARRIER_GUIDE_MOVEMENT,
        sourceId: 'mov-2',
        kind: FinanceEventKind.GUIDE_PURCHASE_VOID
      }
    ])
  })

  it('queues nothing for a store it cannot place', async () => {
    const { listener, queued } = build({ organization: null })
    await listener.onShipmentStatus(shipmentPayload(ShipmentStatus.DELIVERED))
    expect(queued).toEqual([])
  })

  it('lists the source as unposted when the queue is down, and never throws to the operation', async () => {
    const { listener, unposted } = build({ queueFails: true })
    await expect(
      listener.onShipmentStatus(shipmentPayload(ShipmentStatus.DELIVERED))
    ).resolves.toBeUndefined()
    expect(unposted).toMatchObject([
      { sourceType: FinanceSourceType.SHIPMENT, kind: FinanceEventKind.CHARGES }
    ])
  })
})

describe('FinancePostingListener, the returns (E8)', () => {
  it('queues the entry of a return when it is received, as an event of the return', async () => {
    const { listener, queued } = build()
    await listener.onReturnReceived({
      storeId: STORE,
      orderId: 'order-1',
      orderNumber: '1001',
      returnId: 'ret-1',
      actor: { type: 'user', id: 'user-1' }
    })
    expect(queued).toMatchObject([
      {
        organizationId: ORG,
        sourceType: FinanceSourceType.RETURN,
        sourceId: 'ret-1',
        kind: FinanceEventKind.RETURN_RESTOCK
      }
    ])
  })

  it('queues the entry of the refund a person paid out when the return was completed (E14)', async () => {
    const { listener, queued } = build()
    await listener.onReturnRefund({
      storeId: STORE,
      orderId: 'order-1',
      orderNumber: '1001',
      returnId: 'ret-1',
      actor: { type: 'user', id: 'user-1' }
    })
    expect(queued).toMatchObject([
      {
        organizationId: ORG,
        sourceType: FinanceSourceType.RETURN,
        sourceId: 'ret-1',
        kind: FinanceEventKind.RETURN_REFUND
      }
    ])
  })

  it('queues the entry of an order put back as a whole, and none of E2 or E3 for it', async () => {
    const { listener, queued } = build()
    const payload: OrderStatusChangedPayload = {
      storeId: STORE,
      orderId: 'order-1',
      orderNumber: '1001',
      actor: { type: 'user', id: 'user-1' },
      from: OrderStatus.DELIVERED,
      to: OrderStatus.RETURNED,
      notifyCustomer: null
    }
    await listener.onOrderStatus(payload)
    expect(queued.map(job => [job.sourceType, job.sourceId, job.kind])).toEqual([
      [FinanceSourceType.ORDER, 'order-1', FinanceEventKind.ORDER_RETURN]
    ])
  })
})
