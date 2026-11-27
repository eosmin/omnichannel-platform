import type { PinoLogger } from 'nestjs-pino'

import type { EventContext, PrismaService } from '@platform/core/database'
import type { ShipmentEventPayload } from '@platform/core/events'
import type { FiscalDocumentsService } from '@platform/fiscal/runtime'

import type { FiscalSubmissionQueue } from './fiscal-submission.queue'
import { FiscalListener } from './fiscal.listener'

const PAYLOAD = {
  storeId: 'store-1',
  shipmentId: 'ship-1',
  orderId: 'order-1',
  orderNumber: 'N-1',
  connectionId: 'conn-1',
  actor: { type: 'system', id: null }
} as unknown as ShipmentEventPayload

// The database says a unique rule was broken: the shape Prisma gives (the code is all the check reads)
const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

function build(documents: Partial<Record<keyof FiscalDocumentsService, jest.Mock>>) {
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const queue = { enqueue: jest.fn().mockResolvedValue(undefined) }
  const listener = new FiscalListener(
    {
      client: { store: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-1' }) } }
    } as unknown as PrismaService,
    {
      inOrganizationOfStore: (_store: string, work: () => unknown) => work()
    } as unknown as EventContext,
    logger as unknown as PinoLogger,
    documents as unknown as FiscalDocumentsService,
    queue as unknown as FiscalSubmissionQueue
  )
  return { listener, logger, queue }
}

describe('The fiscal listener of the guides (D3b-3)', () => {
  it('queues the note a new guide made', async () => {
    const { listener, queue, logger } = build({
      createRemissionForShipment: jest.fn().mockResolvedValue('doc-1')
    })
    await listener.onShipmentCreated(PAYLOAD)
    expect(queue.enqueue).toHaveBeenCalledWith('org-1', 'doc-1', 1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('takes the loss of a race between replicas as a duplicate, said as a warning and never as an error', async () => {
    const { listener, queue, logger } = build({
      createRemissionForShipment: jest.fn().mockRejectedValue(uniqueViolation)
    })
    await listener.onShipmentCreated(PAYLOAD)
    expect(logger.warn).toHaveBeenCalledWith(
      { shipmentId: 'ship-1' },
      'the remission note of a guide was made by another replica'
    )
    expect(logger.error).not.toHaveBeenCalled()
    expect(queue.enqueue).not.toHaveBeenCalled()
  })

  it('still reports any other failure as an error, and never rejects the dispatch', async () => {
    const { listener, logger } = build({
      createRemissionForShipment: jest.fn().mockRejectedValue(new Error('database down'))
    })
    await expect(listener.onShipmentCreated(PAYLOAD)).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ shipmentId: 'ship-1' }),
      'the remission note of a guide was not made'
    )
  })
})
