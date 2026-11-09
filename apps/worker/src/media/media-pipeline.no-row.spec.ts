import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'
import type { DomainEvents } from '@platform/core/event-bus'
import { JobNames, type ProcessImageJob } from '@platform/core/queues'
import type { StorageService } from '@platform/core/storage-module'

import type { ClamavClient } from './clamav.client'
import { MediaPipeline } from './media-pipeline.service'

// A job whose row is not visible to the worker (dropped meanwhile, or the worker reads another
// database) must leave a trace: it ends without a verdict and nothing else tells why.
describe('MediaPipeline with no row for the job', () => {
  const warn = jest.fn<void, [unknown, string]>()
  const scan = jest.fn()
  const pipeline = new MediaPipeline(
    {
      client: { media: { findUnique: jest.fn().mockResolvedValue(null) } }
    } as unknown as PrismaService,
    {} as unknown as StorageService,
    { scan } as unknown as ClamavClient,
    {} as unknown as DomainEvents,
    { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
    { setContext: jest.fn(), warn } as unknown as PinoLogger
  )

  beforeEach(() => {
    warn.mockClear()
    scan.mockClear()
  })

  it('warns with the media id and the job on a scan, and sends nothing to the daemon', async () => {
    await pipeline.scan('media-1')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({ mediaId: 'media-1', job: JobNames.SCAN_FILE })
    expect(scan).not.toHaveBeenCalled()
  })

  it('warns with the media id and the job on the processing of a picture', async () => {
    await pipeline.processImage('media-2')
    expect(warn.mock.calls[0]?.[0]).toEqual({ mediaId: 'media-2', job: JobNames.PROCESS_IMAGE })
  })
})
