import type { PinoLogger } from 'nestjs-pino'

import type { ExistingAvSanitizer } from '../media/existing-av-sanitizer.service'
import type { ExistingDocumentSanitizer } from '../media/existing-document-sanitizer.service'
import type { ExistingPictureSanitizer } from '../media/existing-picture-sanitizer.service'
import type { VersionedBucketGuard } from '../media/versioned-bucket.guard'

import { ExistingAvScheduler } from './existing-av.scheduler'
import { ExistingDocumentsScheduler } from './existing-documents.scheduler'
import { ExistingPicturesScheduler } from './existing-pictures.scheduler'
import type { LeaderLockService } from './leader-lock.service'

// The two sweeps that rewrite a stored file take no batch while the bucket cannot bring the original back
describe.each([
  ['pictures', ExistingPicturesScheduler],
  ['documents', ExistingDocumentsScheduler],
  ['video and audio', ExistingAvScheduler]
] as const)('the scheduler of the sweep of stored %s', (_name, Scheduler) => {
  const run = jest.fn()
  const allows = jest.fn()
  const logger = { setContext: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() }
  const locks = {
    withLock: jest.fn((_name: string, _seconds: number, work: () => Promise<void>) => work())
  }

  function build() {
    const sanitizer = { run } as unknown as ExistingPictureSanitizer &
      ExistingDocumentSanitizer &
      ExistingAvSanitizer
    const guard = { allows } as unknown as VersionedBucketGuard
    return Scheduler === ExistingPicturesScheduler
      ? new ExistingPicturesScheduler(
          locks as unknown as LeaderLockService,
          sanitizer,
          guard,
          logger as unknown as PinoLogger
        )
      : Scheduler === ExistingAvScheduler
        ? new ExistingAvScheduler(
            locks as unknown as LeaderLockService,
            sanitizer,
            guard,
            logger as unknown as PinoLogger
          )
        : new ExistingDocumentsScheduler(
            locks as unknown as LeaderLockService,
            sanitizer,
            guard,
            logger as unknown as PinoLogger
          )
  }

  beforeEach(() => {
    jest.clearAllMocks()
    run.mockResolvedValue({
      cleaned: 0,
      alreadyClean: 0,
      kept: 0,
      unavailable: 0,
      skipped: 0,
      failed: 0
    })
  })

  it('takes no batch when the guard says no', async () => {
    allows.mockResolvedValue(false)
    await build().run()
    expect(run).not.toHaveBeenCalled()
  })

  it('takes a batch when the guard says yes', async () => {
    allows.mockResolvedValue(true)
    await build().run()
    expect(run).toHaveBeenCalledTimes(1)
  })
})
