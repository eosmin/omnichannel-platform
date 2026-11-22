import type { PinoLogger } from 'nestjs-pino'

import { BucketProtectionStates } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import { VersionedBucketGuard } from './versioned-bucket.guard'

const report = (versioning: string) => ({ encryption: 'on', versioning })

describe('VersionedBucketGuard', () => {
  const inspectProtection = jest.fn()
  const logger = { setContext: jest.fn(), warn: jest.fn() }
  const guard = (required: boolean) =>
    new VersionedBucketGuard(
      { inspectProtection } as unknown as StorageService,
      required,
      logger as unknown as PinoLogger
    )

  beforeEach(() => jest.resetAllMocks())

  it('allows a sweep when the bucket shows versioning on', async () => {
    inspectProtection.mockResolvedValue(report(BucketProtectionStates.ON))
    expect(await guard(true).allows('sweep')).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it.each([BucketProtectionStates.OFF, BucketProtectionStates.UNKNOWN])(
    'stops a sweep in a deployed environment when versioning is %s, and says so',
    async state => {
      inspectProtection.mockResolvedValue(report(state))
      expect(await guard(true).allows('sweep')).toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        { sweep: 'sweep', versioning: state },
        expect.any(String)
      )
    }
  )

  it('stops a sweep when the bucket does not answer, and never throws', async () => {
    inspectProtection.mockRejectedValue(new Error('timed out'))
    expect(await guard(true).allows('sweep')).toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('does not ask the bucket outside a deployed environment', async () => {
    expect(await guard(false).allows('sweep')).toBe(true)
    expect(inspectProtection).not.toHaveBeenCalled()
  })
})
