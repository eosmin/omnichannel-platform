import { InboundLimits } from '@platform/core/domain'
import { InboundEventDropReason } from '@platform/core/metrics'

import { InboundEventQueue } from './inbound-event-queue.service'

function build() {
  const added: unknown[] = []
  const counted: Record<string, string>[] = []
  const warnings: Record<string, unknown>[] = []
  const queue = { addBulk: (jobs: unknown[]) => Promise.resolve(void added.push(...jobs)) }
  const dropped = { inc: (labels: Record<string, string>) => void counted.push(labels) }
  const logger = {
    setContext: () => undefined,
    warn: (fields: Record<string, unknown>) => void warnings.push(fields)
  }
  const service = new InboundEventQueue(queue as never, dropped as never, logger as never)
  return { service, added, counted, warnings }
}

const textEvent = (content: string) => ({
  type: 'message',
  connectionId: 'connection-1',
  channelIdentity: 'customer-1',
  message: { externalId: 'wamid.ABC', type: 'text', content },
  timestamp: new Date().toISOString()
})

describe('InboundEventQueue: an event that does not fit is left out and counted', () => {
  it('names the message and counts a text over the limit apart from the rest', async () => {
    const { service, added, counted, warnings } = build()

    await service.enqueue('whatsapp', [textEvent('a'.repeat(InboundLimits.CONTENT_MAX_LENGTH + 1))])

    expect(added).toHaveLength(0)
    expect(counted).toEqual([{ reason: InboundEventDropReason.CONTENT_TOO_LONG }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      pluginId: 'whatsapp',
      providerMessageId: 'wamid.ABC',
      reason: InboundEventDropReason.CONTENT_TOO_LONG
    })
  })

  it('counts any other event that does not fit as a schema failure, with no id to name', async () => {
    const { service, counted, warnings } = build()

    await service.enqueue('whatsapp', [{ type: 'nonsense' }])

    expect(counted).toEqual([{ reason: InboundEventDropReason.SCHEMA }])
    expect(warnings[0]).toMatchObject({ reason: InboundEventDropReason.SCHEMA })
    expect(warnings[0]).toHaveProperty('providerMessageId', undefined)
  })

  it('cuts an id that is far too long', async () => {
    const { service, warnings } = build()
    const bad = textEvent('a'.repeat(InboundLimits.CONTENT_MAX_LENGTH + 1))
    bad.message.externalId = 'x'.repeat(5000)

    await service.enqueue('whatsapp', [bad])

    expect((warnings[0]?.providerMessageId as string).length).toBe(200)
  })
})
