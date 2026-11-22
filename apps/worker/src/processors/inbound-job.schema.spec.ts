import { ChannelEventTypes } from '@platform/plugins/sdk'

import { processChannelEventJobSchema } from './inbound-job.schema'

const event = {
  type: ChannelEventTypes.CONNECTION_ERROR,
  connectionId: 'c1',
  channelIdentity: 'i1',
  timestamp: '2026-11-22T10:00:00.000Z'
}
const at = '2026-11-22T10:00:00Z'

describe('the job of the inbound queue, as it comes back from Redis', () => {
  it('accepts a plugin id, an event and an instant', () => {
    const parsed = processChannelEventJobSchema.safeParse({
      pluginId: 'acme-chat',
      event,
      receivedAt: at,
      correlationId: 'corr'
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    [
      'a plugin id that is not the id of a channel',
      { pluginId: 'No Good!', event, receivedAt: at }
    ],
    ['an instant that is not a date', { pluginId: 'acme-chat', event, receivedAt: 'yesterday' }],
    ['no event', { pluginId: 'acme-chat', receivedAt: at }],
    [
      'an event with a key the schema does not know',
      { pluginId: 'acme-chat', event: { ...event, extra: 1 }, receivedAt: at }
    ],
    [
      'a correlation id past its length',
      { pluginId: 'acme-chat', event, receivedAt: at, correlationId: 'x'.repeat(200) }
    ]
  ])('refuses %s', (_name, data) => {
    expect(processChannelEventJobSchema.safeParse(data).success).toBe(false)
  })
})
