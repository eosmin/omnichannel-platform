import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  CarrierStatusLimits,
  channelIdSchema,
  OriginMediaSlots,
  type OriginMediaSlot
} from '@platform/core/domain'
import {
  type FetchInboundMediaJob,
  type FetchOriginMediaJob,
  exactly,
  JobNames,
  QueueNames,
  type PollShipmentStatusJob,
  type ProcessImageJob,
  type ReconcileInventoryJob,
  type ReprocessCarrierEventsJob,
  type ScanFileJob
} from '@platform/core/queues'

import { CarrierEventReplay } from '../carriers/carrier-event-replay.service'
import { InventoryReconciler } from '../inventory/inventory-reconciler.service'
import { InboundMediaFetcher } from '../media/inbound-media-fetcher.service'
import { MediaPipeline } from '../media/media-pipeline.service'
import { OriginMediaFetcher } from '../media/origin-media-fetcher.service'
import { ShipmentPoller } from '../shipping/shipment-poller.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

type HeavyJob =
  | ScanFileJob
  | ProcessImageJob
  | FetchInboundMediaJob
  | FetchOriginMediaJob
  | ReconcileInventoryJob
  | PollShipmentStatusJob
  | ReprocessCarrierEventsJob

const originFetchJobSchema = exactly<FetchOriginMediaJob>()(
  z.object({
    storeId: z.uuid(),
    originId: z.uuid(),
    slot: z.enum(Object.values(OriginMediaSlots) as [OriginMediaSlot, ...OriginMediaSlot[]]),
    correlationId: z.string().optional()
  })
)
const reconcileJobSchema = exactly<ReconcileInventoryJob>()(
  z.object({ storeId: z.uuid(), correlationId: z.string().optional() })
)
const pollJobSchema = exactly<PollShipmentStatusJob>()(
  z.object({
    storeId: z.uuid(),
    connectionId: z.uuid(),
    includeOld: z.boolean(),
    correlationId: z.string().optional()
  })
)
const reprocessJobSchema = exactly<ReprocessCarrierEventsJob>()(
  z.object({
    storeId: z.uuid(),
    connectionId: z.uuid(),
    providerCode: z.string().min(1).max(CarrierStatusLimits.PROVIDER_CODE_MAX_LENGTH),
    correlationId: z.string().optional()
  })
)
// A scan and the variants of an image take the same job
const mediaJobSchema = exactly<ScanFileJob & ProcessImageJob>()(
  z.object({ mediaId: z.uuid(), correlationId: z.string().optional() })
)
// The same keys as the job type, checked when it is compiled: zod drops what it is not told about
const fetchJobSchema = exactly<FetchInboundMediaJob>()(
  z.object({
    messageId: z.uuid(),
    index: z.number().int().min(0),
    storeId: z.uuid(),
    pluginId: channelIdSchema,
    connectionId: z.string().min(1),
    mediaRef: z.string().min(1),
    // The id the web widget chose; the fetcher decides whether it may be used
    mediaId: z.string().optional(),
    contentType: z.string(),
    filename: z.string().nullable(),
    correlationId: z.string().optional()
  })
)

// The worker half of a file: fetch what a customer sent, scan it, then make the variants of a clean
// image. One processor for the queue, told apart by the name of the job.
@Processor(QueueNames.HEAVY_PROCESSING, { concurrency: 2 })
export class HeavyProcessingProcessor extends BaseProcessor<HeavyJob> {
  constructor(
    support: ProcessorSupport,
    private readonly pipeline: MediaPipeline,
    private readonly fetcher: InboundMediaFetcher,
    private readonly originFetcher: OriginMediaFetcher,
    private readonly reconciler: InventoryReconciler,
    private readonly poller: ShipmentPoller,
    private readonly carrierReplay: CarrierEventReplay
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
    if (job.name === JobNames.RECONCILE_INVENTORY) {
      const reconcile = reconcileJobSchema.safeParse(job.data)
      if (!reconcile.success)
        throw new UnrecoverableError('the reconcile job does not fit its schema')
      await this.reconciler.reconcileStore(reconcile.data.storeId)
      return
    }
    if (job.name === JobNames.POLL_SHIPMENT_STATUS) {
      const poll = pollJobSchema.safeParse(job.data)
      if (!poll.success) throw new UnrecoverableError('the poll job does not fit its schema')
      await this.poller.poll(poll.data.storeId, poll.data.connectionId, {
        includeOld: poll.data.includeOld
      })
      return
    }
    if (job.name === JobNames.REPROCESS_CARRIER_EVENTS) {
      const reprocess = reprocessJobSchema.safeParse(job.data)
      if (!reprocess.success) {
        throw new UnrecoverableError('the carrier replay job does not fit its schema')
      }
      const report = await this.carrierReplay.reprocess(reprocess.data)
      // Lines that failed or could not be confirmed stay as they were, and the job is asked again: finishing it as a success would
      // leave them kept for good (and a re-sent event of theirs would be taken for a twin)
      if (report.failed + report.unconfirmed > 0) {
        throw new Error('some kept carrier events could not be replayed yet')
      }
      return
    }
    const parsed = mediaJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the media job does not fit its schema')

    switch (job.name) {
      case JobNames.SCAN_FILE:
        return this.pipeline.scan(parsed.data.mediaId, isLastAttempt(job))
      case JobNames.PROCESS_IMAGE:
        return this.pipeline.processImage(parsed.data.mediaId)
      default:
        throw new UnrecoverableError('the heavy-processing queue does not know this job')
    }
  }
}
