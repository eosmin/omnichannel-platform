import { UnrecoverableError } from 'bullmq'

import { ShipmentEventSource, ShipmentStatus } from '@platform/core/domain'
import { JobNames } from '@platform/core/queues'

import type { CarrierEventApplier } from '../carriers/carrier-event-applier.service'
import type { TenantWebhookDeliverer } from '../webhooks/tenant-webhook-deliverer.service'

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
  const webhooks = { deliver: jest.fn((): Promise<string> => Promise.resolve('delivered')) }
  const processor = new CarrierEventsProcessor(
    {} as ProcessorSupport,
    resolver as unknown as CarrierEventApplier,
    webhooks as unknown as TenantWebhookDeliverer
  )
  const handle = (job: unknown) =>
    (processor as unknown as { handle(job: unknown): Promise<void> }).handle(job)
  return { resolver, webhooks, handle }
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

    await expect(handle({ name: JobNames.TRIGGER_PLUGIN_WEBHOOK, data: good })).rejects.toThrow(
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

  describe('the webhooks of the stores', () => {
    const webhookJob = {
      webhookId: '5b1f0c9e-2f0a-4f6e-9a3e-1d2c3b4a5f60',
      storeId: good.storeId,
      deliveryId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      event: 'order.created',
      payload: { storeId: good.storeId, orderId: 'o-1' }
    }

    it('hands a good job to the deliverer with the number of the attempt', async () => {
      const { webhooks, resolver, handle } = build()

      await handle({
        name: JobNames.TRIGGER_WEBHOOK,
        data: webhookJob,
        attemptsMade: 2,
        opts: { attempts: 5 }
      })

      expect(webhooks.deliver).toHaveBeenCalledWith(webhookJob, 3, { maxAttempts: 5 })
      expect(resolver.apply).not.toHaveBeenCalled()
    })

    it('refuses for good a job that does not fit: a store that is not an id, an event nobody can follow, no delivery id', async () => {
      const { webhooks, handle } = build()
      const bad = [
        { ...webhookJob, storeId: 'not-a-uuid' },
        { ...webhookJob, event: 'channel.disconnected' },
        { ...webhookJob, deliveryId: undefined },
        { ...webhookJob, payload: 'text' },
        // It travels as a header: a line break in it would make the post fail on every try
        { ...webhookJob, correlationId: 'a\r\nx-evil: 1' },
        {}
      ]

      for (const data of bad) {
        await expect(handle({ name: JobNames.TRIGGER_WEBHOOK, data })).rejects.toThrow(
          UnrecoverableError
        )
      }
      expect(webhooks.deliver).not.toHaveBeenCalled()
    })

    it('lets a failure of the delivery reach BullMQ, which asks again', async () => {
      const { webhooks, handle } = build()
      webhooks.deliver.mockRejectedValueOnce(new Error('no answer'))

      const attempt = handle({
        name: JobNames.TRIGGER_WEBHOOK,
        data: webhookJob,
        attemptsMade: 0,
        opts: {}
      })

      await expect(attempt).rejects.toThrow('no answer')
      await expect(attempt).rejects.not.toBeInstanceOf(UnrecoverableError)
    })
  })
})
