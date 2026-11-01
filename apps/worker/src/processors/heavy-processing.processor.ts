import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { channelIdSchema, OriginMediaSlots, type OriginMediaSlot } from '@platform/core/domain'
import {
  type FetchInboundMediaJob,
  type FetchOriginMediaJob,
  JobNames,
  QueueNames,
  type ProcessImageJob,
  type ScanFileJob
} from '@platform/core/queues'

import { InboundMediaFetcher } from '../media/inbound-media-fetcher.service'
import { MediaPipeline } from '../media/media-pipeline.service'
import { OriginMediaFetcher } from '../media/origin-media-fetcher.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

type HeavyJob = ScanFileJob | ProcessImageJob | FetchInboundMediaJob | FetchOriginMediaJob

const originFetchJobSchema = z.object({
  storeId: z.uuid(),
  originId: z.uuid(),
  slot: z.enum(Object.values(OriginMediaSlots) as [OriginMediaSlot, ...OriginMediaSlot[]])
})
const mediaJobSchema = z.object({ mediaId: z.uuid() })
const fetchJobSchema = z.object({
  messageId: z.uuid(),
  index: z.number().int().min(0),
  storeId: z.uuid(),
  pluginId: channelIdSchema,
  connectionId: z.string().min(1),
  mediaRef: z.string().min(1),
  contentType: z.string(),
  filename: z.string().nullable()
})

// The worker half of a file: fetch what a customer sent, scan it, then make the variants of a clean
// image. One processor for the queue, told apart by the name of the job.
@Processor(QueueNames.HEAVY_PROCESSING, { concurrency: 2 })
export class HeavyProcessingProcessor extends BaseProcessor<HeavyJob> {
  constructor(
    support: ProcessorSupport,
    private readonly pipeline: MediaPipeline,
    private readonly fetcher: InboundMediaFetcher,
    private readonly originFetcher: OriginMediaFetcher
  ) {
    super(QueueNames.HEAVY_PROCESSING, support)
  }

  protected async handle(job: Job<HeavyJob>): Promise<void> {
    if (job.name === JobNames.FETCH_INBOUND_MEDIA) {
      const fetch = fetchJobSchema.safeParse(job.data)
      // The job crossed Redis: what does not fit now will not fit when it is tried again
      if (!fetch.success) throw new UnrecoverableError('the fetch job does not fit its schema')
      return this.fetcher.fetch(fetch.data, isLastAttempt(job))
    }
    if (job.name === JobNames.FETCH_ORIGIN_MEDIA) {
      const fetch = originFetchJobSchema.safeParse(job.data)
      if (!fetch.success) throw new UnrecoverableError('the fetch job does not fit its schema')
      return this.originFetcher.fetch(fetch.data)
    }
    const parsed = mediaJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the media job does not fit its schema')

    switch (job.name) {
      case JobNames.SCAN_FILE:
        return this.pipeline.scan(parsed.data.mediaId)
      case JobNames.PROCESS_IMAGE:
        return this.pipeline.processImage(parsed.data.mediaId)
      default:
        throw new UnrecoverableError('the heavy-processing queue does not know this job')
    }
  }
}
