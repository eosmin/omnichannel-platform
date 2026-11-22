import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'
import { WebhookLimits } from '@platform/core/domain'

import { PluginWebhookDayCap } from './plugin-webhook-day-cap'

// The script itself runs in Redis and is proved with the real one (tests/api/plugin-webhooks.spec.ts); what is proved here is what
// is handed to it and how its answer is read
function capOver(reply: unknown) {
  const calls: unknown[][] = []
  const redis = {
    eval: (...args: unknown[]) => {
      calls.push(args)
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
    }
  } as unknown as Redis
  return { cap: new PluginWebhookDayCap(redis), calls }
}

describe('PluginWebhookDayCap', () => {
  it('asks for a place in the key of the installation, with the window, the cap and the delivery', async () => {
    const { cap, calls } = capOver(1)

    await expect(cap.take('inst-1', 'del-1', 50, 1_000)).resolves.toBe(true)

    const [, keys, key, now, window, limit, member] = calls[0] ?? []
    expect(keys).toBe(1)
    expect(key).toBe(CacheKeys.plugin.webhookDay('inst-1'))
    expect([now, window, limit, member]).toEqual([
      '1000',
      String(WebhookLimits.PLUGIN_DAY_MS),
      '50',
      'del-1'
    ])
  })

  it('holds a cap above the ceiling at the ceiling, so Redis never keeps more than that for one installation', async () => {
    const { cap, calls } = capOver(1)

    await cap.take('inst-1', 'del-1', 1_000_000, 1_000)

    expect(calls[0]?.[5]).toBe(String(WebhookLimits.PLUGIN_DAY_CAP_CEILING))
    expect(WebhookLimits.PLUGIN_DAY_CAP_CEILING).toBeLessThanOrEqual(100_000)
  })

  it('says no when the script says the cap is reached', async () => {
    const { cap } = capOver(0)

    await expect(cap.take('inst-1', 'del-1', 1, 1_000)).resolves.toBe(false)
  })

  it('throws, and never passes, when Redis fails or answers something unreadable', async () => {
    await expect(capOver(new Error('down')).cap.take('i', 'd', 1, 1)).rejects.toThrow('down')
    await expect(capOver('yes').cap.take('i', 'd', 1, 1)).rejects.toThrow('unreadable')
    await expect(capOver(null).cap.take('i', 'd', 1, 1)).rejects.toThrow('unreadable')
  })
})
