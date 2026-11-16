import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  bulkLocationIdsSchema,
  bulkLocationsByConnectionSchema,
  CarrierStatusLimits,
  channelIdSchema,
  FinanceEventKind,
  FinanceSourceType,
  OriginMediaSlots,
  type OriginMediaSlot,
  shipmentPickupSchema
} from '@platform/core/domain'
import { FinancePostingService } from '@platform/core/finance-ledger'
import {
  type BulkLabelsMergeJob,
  type CancelShipmentJob,
  type EnforceRetentionJob,
  type EvaluatePickupsJob,
  type FetchInboundMediaJob,
  type FetchOriginMediaJob,
  type PostFinanceEventJob,
  exactly,
  JobNames,
  QueueNames,
  type PollShipmentStatusJob,
  type ProcessImageJob,
  type ReconcileFinanceJob,
  type SubmitFiscalDocumentJob,
  type ReconcileInventoryJob,
  type ReprocessCarrierEventsJob,
  type ScanFileJob,
  type SyncPickupJob,
  type VerifyLedgerChainJob
} from '@platform/core/queues'
import { FiscalDocumentBusyError, FiscalDocumentsService } from '@platform/fiscal/runtime'

import { CarrierEventReplay } from '../carriers/carrier-event-replay.service'
import { FinanceChainChecker } from '../finance/finance-chain-checker.service'
import { FinanceReconciler } from '../finance/finance-reconciler.service'
import { FiscalReconciler } from '../finance/fiscal-reconciler.service'
import { InventoryReconciler } from '../inventory/inventory-reconciler.service'
import { InboundMediaFetcher } from '../media/inbound-media-fetcher.service'
import { MediaPipeline } from '../media/media-pipeline.service'
import { OriginMediaFetcher } from '../media/origin-media-fetcher.service'
import { StoreRetentionEnforcer } from '../retention/store-retention-enforcer.service'
import { BulkLabelsRunner } from '../shipping/bulk-labels-runner.service'
import { PickupEvaluator } from '../shipping/pickup-evaluator.service'
import { PickupSyncer } from '../shipping/pickup-syncer.service'
import { ShipmentCanceller } from '../shipping/shipment-canceller.service'
import { ShipmentPoller } from '../shipping/shipment-poller.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

type HeavyJob =
  | ScanFileJob
  | ProcessImageJob
  | FetchInboundMediaJob
  | FetchOriginMediaJob
  | ReconcileInventoryJob
  | ReconcileFinanceJob
  | VerifyLedgerChainJob
  | PollShipmentStatusJob
  | ReprocessCarrierEventsJob
  | BulkLabelsMergeJob
  | CancelShipmentJob
  | SyncPickupJob
  | EvaluatePickupsJob
  | EnforceRetentionJob
  | PostFinanceEventJob
  | SubmitFiscalDocumentJob

const bulkLabelsJobSchema = exactly<BulkLabelsMergeJob>()(
  z.object({
    storeId: z.uuid(),
    jobId: z.uuid(),
    connectionId: z.uuid().optional(),
    locationIds: bulkLocationIdsSchema.optional(),
    locationsByConnection: bulkLocationsByConnectionSchema.optional(),
    pickup: shipmentPickupSchema.optional(),
    canOverridePrice: z.boolean(),
    correlationId: z.string().optional()
  })
)
const cancelShipmentJobSchema = exactly<CancelShipmentJob>()(
  z.object({
    storeId: z.uuid(),
    shipmentId: z.uuid(),
    requestedBy: z.uuid().nullable(),
    correlationId: z.string().optional()
  })
)
const syncPickupJobSchema = exactly<SyncPickupJob>()(
  z.object({
    storeId: z.uuid(),
    pickupId: z.uuid(),
    requestedBy: z.uuid().nullable(),
    correlationId: z.string().optional()
  })
)
const evaluatePickupsJobSchema = exactly<EvaluatePickupsJob>()(
  z.object({ minute: z.number().int().positive(), correlationId: z.string().optional() })
)
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
const reconcileFinanceJobSchema = exactly<ReconcileFinanceJob>()(
  z.object({ organizationId: z.uuid(), correlationId: z.string().optional() })
)
const verifyLedgerChainJobSchema = exactly<VerifyLedgerChainJob>()(
  z.object({ organizationId: z.uuid(), correlationId: z.string().optional() })
)
const postFinanceJobSchema = exactly<PostFinanceEventJob>()(
  z.object({
    organizationId: z.uuid(),
    sourceType: z.enum(FinanceSourceType),
    sourceId: z.uuid(),
    kind: z.enum(FinanceEventKind),
    occurredAt: z.iso.datetime().optional(),
    correlationId: z.string().optional()
  })
)
const submitFiscalJobSchema = exactly<SubmitFiscalDocumentJob>()(
  z.object({
    organizationId: z.uuid(),
    documentId: z.uuid(),
    correlationId: z.string().optional()
  })
)
const retentionJobSchema = exactly<EnforceRetentionJob>()(
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
    requestedBy: z.uuid().optional(),
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
    private readonly carrierReplay: CarrierEventReplay,
    private readonly bulkLabels: BulkLabelsRunner,
    private readonly canceller: ShipmentCanceller,
    private readonly pickupSyncer: PickupSyncer,
    private readonly pickupEvaluator: PickupEvaluator,
    private readonly retention: StoreRetentionEnforcer,
    private readonly financePosting: FinancePostingService,
    private readonly financeReconciler: FinanceReconciler,
    private readonly financeChain: FinanceChainChecker,
    private readonly fiscalReconciler: FiscalReconciler,
    private readonly fiscalDocuments: FiscalDocumentsService
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
    if (job.name === JobNames.RECONCILE_FINANCE) {
      const reconcile = reconcileFinanceJobSchema.safeParse(job.data)
      if (!reconcile.success) {
        throw new UnrecoverableError('the finance reconcile job does not fit its schema')
      }
      // The two checks do not hide each other: each runs whatever the other did, and the first failure rejects the job so the queue asks
      // again (both are idempotent)
      const failures: Error[] = []
      for (const check of [this.financeReconciler, this.fiscalReconciler]) {
        try {
          await check.reconcile(reconcile.data.organizationId)
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)))
        }
      }
      // One failure is itself; two are both, so neither cause is lost
      const [only] = failures
      if (only !== undefined && failures.length === 1) throw only
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'the checks of the books and of the fiscal documents failed'
        )
      }
      return
    }
    if (job.name === JobNames.VERIFY_LEDGER_CHAIN) {
      const verify = verifyLedgerChainJobSchema.safeParse(job.data)
      if (!verify.success) {
        throw new UnrecoverableError('the chain check job does not fit its schema')
      }
      // A break is an incident the check records and returns; only an error of the infrastructure rejects, and the queue asks again
      await this.financeChain.check(verify.data.organizationId)
      return
    }
    if (job.name === JobNames.SUBMIT_FISCAL_DOCUMENT) {
      const submit = submitFiscalJobSchema.safeParse(job.data)
      if (!submit.success) throw new UnrecoverableError('the fiscal job does not fit its schema')
      // Throws when the provider did not answer, so the queue tries again with its backoff; a decision (accepted, rejected) returns
      try {
        await this.fiscalDocuments.submit(submit.data.organizationId, submit.data.documentId)
      } catch (error) {
        // The last attempt: nobody retries it after this, so a person is told. The original error stays the one the queue sees.
        if (isLastAttempt(job)) {
          // Never throws (it logs its own failure): the original error stays the one the queue sees
          await this.fiscalDocuments.reportExhausted(
            submit.data.organizationId,
            submit.data.documentId,
            error instanceof FiscalDocumentBusyError
          )
        }
        throw error
      }
      return
    }
    if (job.name === JobNames.POST_FINANCE_EVENT) {
      const post = postFinanceJobSchema.safeParse(job.data)
      if (!post.success) throw new UnrecoverableError('the posting job does not fit its schema')
      // A failure of the books is recorded for a person and returns; only an error of the infrastructure rejects, and the queue asks again
      try {
        await this.financePosting.post(post.data)
      } catch (error) {
        // The last attempt of an error of the infrastructure: the source goes on the list of failures instead of the dead-letter queue
        if (isLastAttempt(job)) {
          // The same database may be what failed: the original error stays the one the queue sees
          await this.financePosting.markUnposted(post.data).catch(() => undefined)
        }
        throw error
      }
      return
    }
    if (job.name === JobNames.ENFORCE_RETENTION) {
      const enforce = retentionJobSchema.safeParse(job.data)
      if (!enforce.success)
        throw new UnrecoverableError('the retention job does not fit its schema')
      // Rejects when a category failed (after the others ran): the queue asks again and finds what is left
      await this.retention.enforce(enforce.data.storeId)
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
    if (job.name === JobNames.BULK_LABELS_MERGE) {
      const bulk = bulkLabelsJobSchema.safeParse(job.data)
      if (!bulk.success) throw new UnrecoverableError('the bulk labels job does not fit its schema')
      // The last attempt that ends on a fault closes the run as failed; an earlier one is repeated and finds what it made
      await this.bulkLabels.run(bulk.data, isLastAttempt(job))
      return
    }
    if (job.name === JobNames.CANCEL_SHIPMENT) {
      const cancel = cancelShipmentJobSchema.safeParse(job.data)
      if (!cancel.success) throw new UnrecoverableError('the void job does not fit its schema')
      // Rejects while the carrier does not answer (the queue asks again); the last attempt closes the void as failed
      await this.canceller.run(cancel.data, isLastAttempt(job))
      return
    }
    if (job.name === JobNames.EVALUATE_PICKUPS) {
      const evaluate = evaluatePickupsJobSchema.safeParse(job.data)
      if (!evaluate.success) {
        throw new UnrecoverableError('the pickup evaluation job does not fit its schema')
      }
      await this.pickupEvaluator.run(evaluate.data)
      return
    }
    if (job.name === JobNames.SYNC_PICKUP) {
      const sync = syncPickupJobSchema.safeParse(job.data)
      if (!sync.success) throw new UnrecoverableError('the pickup job does not fit its schema')
      // Rejects while the carrier does not answer (the queue asks again); the last attempt ends the pickup as failed
      await this.pickupSyncer.run(sync.data, isLastAttempt(job))
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
