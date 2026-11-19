import { Logger } from '@nestjs/common'

import { WorkerRoleCheck } from './worker-role.check'

const build = (bypass: boolean | undefined, contextOn = false) => {
  const set = jest.fn()
  const rows = bypass === undefined ? [] : [{ bypass }]
  const check = new WorkerRoleCheck(
    { client: { $queryRaw: () => Promise.resolve(rows) } } as never,
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
})
