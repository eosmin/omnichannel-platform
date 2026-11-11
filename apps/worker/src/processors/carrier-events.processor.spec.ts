import { UnrecoverableError } from 'bullmq'

import { ShipmentEventSource, ShipmentStatus } from '@platform/core/domain'
import { JobNames } from '@platform/core/queues'

import type { CarrierEventApplier } from '../carriers/carrier-event-applier.service'

import { CarrierEventsProcessor } from './carrier-events.processor'
import type { ProcessorSupport } from './processor-support'

const good = {
  storeId: '7f0d8b0e-62f4-4c3c-9d3e-0c5ac3ef7a11',
  connectionId: '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0',
  event: {
    providerEventId: 'e-1',
    status: ShipmentStatus.DELIVERED,
    rawStatus: 'Entregado',
    occurredAt: '2026-11-11T10:00:00.000Z'
  },
  receivedAt: '2026-11-11T10:00:01.000Z'
}

function build() {
  const resolver = { apply: jest.fn((): Promise<string> => Promise.resolve('ignored')) }
  const processor = new CarrierEventsProcessor(
    {} as ProcessorSupport,
    resolver as unknown as CarrierEventApplier
  )
  const handle = (job: unknown) =>
    (processor as unknown as { handle(job: unknown): Promise<void> }).handle(job)
  return { resolver, handle }
}

describe('CarrierEventsProcessor', () => {
  it('hands a good event to the applier, as a webhook', async () => {
    const { resolver, handle } = build()

    await handle({ name: JobNames.PROCESS_CARRIER_EVENT, data: good })

    expect(resolver.apply).toHaveBeenCalledWith(good, ShipmentEventSource.WEBHOOK)
  })

  it('refuses for good a job that does not fit its schema, where a retry would change nothing', async () => {
    const { resolver, handle } = build()
    const bad = [
      { ...good, storeId: 'not-a-uuid' },
      { ...good, event: { ...good.event, status: 'teleported' } },
      { ...good, event: { ...good.event, rawStatus: '' } },
      { ...good, event: { ...good.event, status: ShipmentStatus.CREATING } },
      { ...good, event: { ...good.event, rawStatus: 'a'.repeat(60), rawReason: 'b'.repeat(60) } },
      { ...good, event: { ...good.event, rawStatus: 'x'.repeat(500) } },
      { ...good, event: { ...good.event, occurredAt: 'yesterday' } },
      { connectionId: good.connectionId },
      {}
    ]

    for (const data of bad) {
      await expect(handle({ name: JobNames.PROCESS_CARRIER_EVENT, data })).rejects.toThrow(
        UnrecoverableError
      )
    }
    expect(resolver.apply).not.toHaveBeenCalled()
  })

  it('keeps what it was sent: a key the schema does not name is not passed on', async () => {
    const { resolver, handle } = build()

    await handle({
      name: JobNames.PROCESS_CARRIER_EVENT,
      data: { ...good, correlationId: 'corr', extra: 'dropped' }
    })

    expect(resolver.apply).toHaveBeenCalledWith(
      { ...good, correlationId: 'corr' },
      ShipmentEventSource.WEBHOOK
    )
  })

  it('does not pass on the free text of the carrier: the job keeps status fields only', async () => {
    const { resolver, handle } = build()

    await handle({
      name: JobNames.PROCESS_CARRIER_EVENT,
      data: { ...good, event: { ...good.event, description: 'Entregado a Juan Perez, Calle X 1' } }
    })

    expect(JSON.stringify(resolver.apply.mock.calls)).not.toContain('Juan')
    expect(resolver.apply).toHaveBeenCalledWith(good, ShipmentEventSource.WEBHOOK)
  })

  it('refuses a job of the queue that it has no name for', async () => {
    const { resolver, handle } = build()

    await expect(handle({ name: JobNames.TRIGGER_WEBHOOK, data: good })).rejects.toThrow(
      UnrecoverableError
    )
    expect(resolver.apply).not.toHaveBeenCalled()
  })

  it.each(['unconfirmed', 'not_found'])(
    'asks again later for an event the applier says is %s, and does not give up on it for good',
    async outcome => {
      const { resolver, handle } = build()
      resolver.apply.mockResolvedValueOnce(outcome)

      const attempt = handle({ name: JobNames.PROCESS_CARRIER_EVENT, data: good })

      await expect(attempt).rejects.toThrow('not settled yet')
      await expect(attempt).rejects.not.toBeInstanceOf(UnrecoverableError)
    }
  )
})
