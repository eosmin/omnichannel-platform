import { Logger } from '@nestjs/common'

import { WorkerRoleCheck } from './worker-role.check'

const build = (bypass: boolean | undefined, contextOn = false, fail = false) => {
  const set = jest.fn()
  const rows = bypass === undefined ? [] : [{ bypass }]
  const check = new WorkerRoleCheck(
    {
      client: {
        $queryRaw: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(rows))
      }
    } as never,
    contextOn,
    { set } as never
  )
  return { check, set }
}

describe('WorkerRoleCheck', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('warns and sets the gauge to one when the role bypasses and the flag is off', async () => {
    const { check, set } = build(true)
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(set).toHaveBeenCalledWith(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('fails the start when the role bypasses and the flag is on', async () => {
    const { check, set } = build(true, true)
    await expect(check.onApplicationBootstrap()).rejects.toThrow(/BYPASSRLS/)
    expect(set).toHaveBeenCalledWith(1)
  })

  it('is silent for a role that cannot bypass, with the flag on', async () => {
    const { check, set } = build(false, true)
    await check.onApplicationBootstrap()
    expect(set).toHaveBeenCalledWith(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('is silent for a role that cannot bypass, with the flag off', async () => {
    const { check, set } = build(false)
    await check.onApplicationBootstrap()
    expect(set).toHaveBeenCalledWith(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not call a missing role safe: warns with the flag off, fails with it on, no gauge', async () => {
    const off = build(undefined)
    await off.check.onApplicationBootstrap()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(off.set).not.toHaveBeenCalled()
    const on = build(undefined, true)
    await expect(on.check.onApplicationBootstrap()).rejects.toThrow(/could not be read/)
    expect(on.set).not.toHaveBeenCalled()
  })

  it('a database error only warns with the flag off and stops the start with it on', async () => {
    const off = build(true, false, true)
    await expect(off.check.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    await expect(build(true, true, true).check.onApplicationBootstrap()).rejects.toThrow('db down')
  })
})
