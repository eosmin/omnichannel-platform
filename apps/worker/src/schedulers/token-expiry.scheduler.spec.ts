import { LockNames } from '@platform/core/queues'

import { TokenExpiryScheduler } from './token-expiry.scheduler'

// The services are injected as stubs; their modules read the environment when imported (CI has no DATABASE_URL), so they are not loaded
jest.mock('@platform/channels/connections', () => ({ ChannelTokenExpiryService: class {} }))
jest.mock('@platform/plugins/runtime', () => ({ PluginRegistry: class {} }))
jest.mock('./leader-lock.service', () => ({ LeaderLockService: class {} }))

function build(options: { held?: boolean; runDue?: jest.Mock } = {}) {
  const withLock = jest.fn((_name: string, _seconds: number, fn: () => Promise<void>) =>
    options.held === true ? Promise.resolve(false) : fn().then(() => true)
  )
  const runDue = options.runDue ?? jest.fn().mockResolvedValue({ asked: 3, written: 2 })
  const find = jest.fn((id: string) => ({ id }))
  const logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() }
  const scheduler = new TokenExpiryScheduler(
    { withLock } as never,
    { runDue } as never,
    { find } as never,
    logger as never
  )
  return { scheduler, withLock, runDue, find, logger }
}

describe('TokenExpiryScheduler', () => {
  it('runs the due checks under the leader lock, with the registry as the way to find a plugin', async () => {
    const { scheduler, withLock, runDue, find, logger } = build()

    await scheduler.run()

    expect(withLock).toHaveBeenCalledWith(
      LockNames.CHECK_TOKEN_EXPIRY,
      expect.any(Number),
      expect.any(Function)
    )
    const [resolve] = runDue.mock.calls[0] as [(id: string) => unknown]
    expect(resolve('plugin_x')).toEqual({ id: 'plugin_x' })
    expect(find).toHaveBeenCalledWith('plugin_x')
    expect(logger.info).toHaveBeenCalledWith({ asked: 3, written: 2 }, 'channel tokens checked')
  })

  it('holds the lock longer than the budget of a round, so a replica that died does not skip the next one for long', async () => {
    const { scheduler, withLock } = build()
    await scheduler.run()
    const seconds = withLock.mock.calls[0]?.[1] as number
    expect(seconds).toBeGreaterThan(60)
  })

  it('asks nothing when another replica holds the lock', async () => {
    const { scheduler, runDue } = build({ held: true })
    await scheduler.run()
    expect(runDue).not.toHaveBeenCalled()
  })

  it('logs the failure of a round and does not throw, so the worker stays up and the next round tries again', async () => {
    const { scheduler, logger } = build({ runDue: jest.fn().mockRejectedValue(new TypeError('x')) })

    await expect(scheduler.run()).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith(
      { errorName: 'TypeError' },
      'the channel token round failed'
    )
  })
})
