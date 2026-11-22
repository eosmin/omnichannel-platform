import { LockNames } from '@platform/core/queues'

import { ChannelHealthScheduler } from './channel-health.scheduler'

// The services are injected as stubs; their modules read the environment when imported (CI has no DATABASE_URL), so they are not loaded
jest.mock('@platform/channels/connections', () => ({ ChannelHealthService: class {} }))
jest.mock('@platform/channels/remote', () => ({ RemoteChannelHealthService: class {} }))
jest.mock('@platform/plugins/runtime', () => ({ PluginRegistry: class {} }))
jest.mock('./leader-lock.service', () => ({ LeaderLockService: class {} }))

function build(options: { held?: boolean; checkAll?: jest.Mock; remoteCheckAll?: jest.Mock } = {}) {
  const withLock = jest.fn((_name: string, _seconds: number, fn: () => Promise<void>) =>
    options.held === true ? Promise.resolve(false) : fn().then(() => true)
  )
  const checkAll = options.checkAll ?? jest.fn().mockResolvedValue({ checked: 4, unhealthy: 1 })
  const remoteCheckAll =
    options.remoteCheckAll ?? jest.fn().mockResolvedValue({ checked: 2, unhealthy: 0 })
  const registry = { find: jest.fn((id: string) => ({ id })), isRemote: jest.fn(() => true) }
  const logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() }
  const scheduler = new ChannelHealthScheduler(
    { withLock } as never,
    { checkAll } as never,
    { checkAll: remoteCheckAll } as never,
    registry as never,
    logger as never
  )
  return { scheduler, withLock, checkAll, remoteCheckAll, registry, logger }
}

describe('ChannelHealthScheduler', () => {
  it('checks the plugins of the connections under the lock of its round, and leaves the remote ones to their own round', async () => {
    const { scheduler, withLock, checkAll, remoteCheckAll, registry, logger } = build()

    await scheduler.run()

    expect(withLock).toHaveBeenCalledWith(
      LockNames.CHECK_CHANNEL_HEALTH,
      expect.any(Number),
      expect.any(Function)
    )
    const [, , isRemote] = checkAll.mock.calls[0] as [unknown, unknown, (id: string) => boolean]
    expect(isRemote('plugin_x')).toBe(true)
    expect(registry.isRemote).toHaveBeenCalledWith('plugin_x')
    expect(remoteCheckAll).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith({ checked: 4, unhealthy: 1 }, 'channel health checked')
  })

  it('runs the remote plugins in a round with a lock of its own', async () => {
    const { scheduler, withLock, remoteCheckAll, checkAll } = build()

    await scheduler.runRemote()

    expect(withLock).toHaveBeenCalledWith(
      LockNames.CHECK_REMOTE_CHANNEL_HEALTH,
      expect.any(Number),
      expect.any(Function)
    )
    expect(LockNames.CHECK_REMOTE_CHANNEL_HEALTH).not.toBe(LockNames.CHECK_CHANNEL_HEALTH)
    expect(remoteCheckAll).toHaveBeenCalledTimes(1)
    expect(checkAll).not.toHaveBeenCalled()
  })

  it('checks nothing when another replica holds the lock', async () => {
    const { scheduler, checkAll, remoteCheckAll } = build({ held: true })
    await scheduler.run()
    await scheduler.runRemote()
    expect(checkAll).not.toHaveBeenCalled()
    expect(remoteCheckAll).not.toHaveBeenCalled()
  })

  it('logs the failure of either round and does not throw', async () => {
    const boom = new Error('boom')
    const { scheduler, logger } = build({
      checkAll: jest.fn().mockRejectedValue(boom),
      remoteCheckAll: jest.fn().mockRejectedValue(boom)
    })

    await expect(scheduler.run()).resolves.toBeUndefined()
    await expect(scheduler.runRemote()).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith({ err: boom }, 'the channel health round failed')
    expect(logger.error).toHaveBeenCalledWith(
      { err: boom },
      'the remote channel health round failed'
    )
  })
})
