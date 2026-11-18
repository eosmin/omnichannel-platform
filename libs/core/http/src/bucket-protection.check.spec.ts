import { Logger } from '@nestjs/common'

import type { StorageService } from '@platform/core/storage-module'

import { BucketProtectionCheck } from './bucket-protection.check'

const build = (enabled: boolean, inspect: jest.Mock) => {
  const set = jest.fn()
  const check = new BucketProtectionCheck(
    { inspectProtection: inspect } as unknown as StorageService,
    enabled,
    { set } as never
  )
  return { check, set }
}

describe('BucketProtectionCheck', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => jest.restoreAllMocks())

  it('asks nothing outside a deployed environment', async () => {
    const inspect = jest.fn()
    const { check, set } = build(false, inspect)
    await check.onApplicationBootstrap()
    expect(inspect).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('is silent and sets both gauges to zero for a protected bucket', async () => {
    const { check, set } = build(
      true,
      jest.fn().mockResolvedValue({ encryption: 'on', versioning: 'on' })
    )
    await check.onApplicationBootstrap()
    expect(warn).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith({ protection: 'encryption' }, 0)
    expect(set).toHaveBeenCalledWith({ protection: 'versioning' }, 0)
  })

  it('warns and raises the gauge for each protection that is off or unknown', async () => {
    const { check, set } = build(
      true,
      jest.fn().mockResolvedValue({ encryption: 'off', versioning: 'unknown' })
    )
    await check.onApplicationBootstrap()
    expect(set).toHaveBeenCalledWith({ protection: 'encryption' }, 1)
    expect(set).toHaveBeenCalledWith({ protection: 'versioning' }, 1)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no encryption'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not say whether versioning'))
  })

  it('never fails the boot when the bucket cannot be reached', async () => {
    const { check } = build(true, jest.fn().mockRejectedValue(new Error('down')))
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be checked: down'))
  })
})
