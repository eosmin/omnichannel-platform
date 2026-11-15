import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import { RemoteChannelApiLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { PluginChannelLimitsStore } from './plugin-channel-limits.store'

const INSTALLATION = '00000000-0000-4000-8000-0000000000a1'
const CONVERSATION = '00000000-0000-4000-8000-0000000000e1'

function build(): { store: PluginChannelLimitsStore; redis: { eval: jest.Mock; set: jest.Mock } } {
  const redis = { eval: jest.fn(), set: jest.fn() }
  return { store: new PluginChannelLimitsStore(redis as never), redis }
}

describe('PluginChannelLimitsStore.takeEvents', () => {
  it('adds the events to the counter of the installation, with the window of a minute', async () => {
    const { store, redis } = build()
    redis.eval.mockResolvedValue([10, 55])
    await expect(store.takeEvents(INSTALLATION, 10)).resolves.toBeUndefined()
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('INCRBY'),
      1,
      CacheKeys.plugin.channelEventsWindow(INSTALLATION),
      '10',
      String(RemoteChannelApiLimits.EVENTS_WINDOW_SECONDS)
    )
  })

  it('takes the 3000th event of the minute', async () => {
    const { store, redis } = build()
    redis.eval.mockResolvedValue([RemoteChannelApiLimits.MAX_EVENTS_PER_MINUTE, 30])
    await expect(store.takeEvents(INSTALLATION, 1)).resolves.toBeUndefined()
  })

  it('answers 429 with the seconds the window has left past the ceiling', async () => {
    const { store, redis } = build()
    redis.eval.mockResolvedValue([RemoteChannelApiLimits.MAX_EVENTS_PER_MINUTE + 1, 42])
    await expect(store.takeEvents(INSTALLATION, 1)).rejects.toMatchObject({
      code: ErrorCodes.RATE_LIMIT_EXCEEDED,
      statusCode: HttpStatusCodes.TOO_MANY_REQUESTS,
      metadata: { [RETRY_AFTER_METADATA_KEY]: 42 }
    })
  })

  it('always tells to wait at least a second', async () => {
    const { store, redis } = build()
    redis.eval.mockResolvedValue([RemoteChannelApiLimits.MAX_EVENTS_PER_MINUTE + 1, 0])
    await expect(store.takeEvents(INSTALLATION, 1)).rejects.toMatchObject({
      metadata: { [RETRY_AFTER_METADATA_KEY]: 1 }
    })
  })

  it('fails closed when Redis is down or answers something else', async () => {
    const down = build()
    down.redis.eval.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(down.store.takeEvents(INSTALLATION, 1)).rejects.toMatchObject({
      statusCode: HttpStatusCodes.SERVICE_UNAVAILABLE
    })
    for (const reply of [null, 'x', [1], ['1', 2]]) {
      const odd = build()
      odd.redis.eval.mockResolvedValue(reply)
      await expect(odd.store.takeEvents(INSTALLATION, 1)).rejects.toMatchObject({
        statusCode: HttpStatusCodes.SERVICE_UNAVAILABLE
      })
    }
  })
})

describe('PluginChannelLimitsStore.takeTyping', () => {
  it('lets the first typing of a conversation through and holds the next ones for 2 seconds', async () => {
    const { store, redis } = build()
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null)
    await expect(store.takeTyping(CONVERSATION)).resolves.toBe(true)
    await expect(store.takeTyping(CONVERSATION)).resolves.toBe(false)
    expect(redis.set).toHaveBeenCalledWith(
      CacheKeys.plugin.channelTyping(CONVERSATION),
      '1',
      'PX',
      RemoteChannelApiLimits.TYPING_GAP_MS,
      'NX'
    )
  })

  it('does not pass a typing on when Redis is down: it is a courtesy', async () => {
    const { store, redis } = build()
    redis.set.mockRejectedValue(new Error('down'))
    await expect(store.takeTyping(CONVERSATION)).resolves.toBe(false)
  })
})
