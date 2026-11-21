import { PluginApiKeyProbeThrottle } from '@platform/core/auth'

import { PluginKeyProbeLimiter } from './plugin-key-probe-limiter'

function build(overrides: { blockedFor?: jest.Mock; increment?: jest.Mock } = {}) {
  const storage = {
    blockedFor: overrides.blockedFor ?? jest.fn().mockResolvedValue(0),
    increment: overrides.increment ?? jest.fn().mockResolvedValue({})
  }
  const hits = { inc: jest.fn() }
  const limiter = new PluginKeyProbeLimiter(storage as never, hits as never)
  return { limiter, storage, hits }
}

describe('PluginKeyProbeLimiter', () => {
  it('asks the block of the address under the profile, without counting a hit', async () => {
    const { limiter, storage } = build({ blockedFor: jest.fn().mockResolvedValue(42) })

    await expect(limiter.retryAfter('203.0.113.7')).resolves.toBe(42)

    expect(storage.blockedFor).toHaveBeenCalledWith('203.0.113.7', PluginApiKeyProbeThrottle.name)
    expect(storage.increment).not.toHaveBeenCalled()
  })

  it('counts a failure in the window of the profile and blocks for as long as the window', async () => {
    const { limiter, storage } = build()

    await limiter.recordFailure('203.0.113.7')

    expect(storage.increment).toHaveBeenCalledWith(
      '203.0.113.7',
      PluginApiKeyProbeThrottle.ttlMs,
      PluginApiKeyProbeThrottle.limit,
      PluginApiKeyProbeThrottle.ttlMs,
      PluginApiKeyProbeThrottle.name
    )
  })

  it('lets the call through when Redis fails, on the read and on the count', async () => {
    const { limiter } = build({
      blockedFor: jest.fn().mockRejectedValue(new Error('down')),
      increment: jest.fn().mockRejectedValue(new Error('down'))
    })

    await expect(limiter.retryAfter('203.0.113.7')).resolves.toBe(0)
    await expect(limiter.recordFailure('203.0.113.7')).resolves.toBeUndefined()
  })

  it('counts a refusal in the metric by throttler, never by address', () => {
    const { limiter, hits } = build()

    limiter.countRefusal()

    expect(hits.inc).toHaveBeenCalledWith({ throttler: PluginApiKeyProbeThrottle.name })
  })
})
