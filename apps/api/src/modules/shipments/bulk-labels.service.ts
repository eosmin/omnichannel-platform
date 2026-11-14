import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions, RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { lockStoreScope, PrismaService } from '@platform/core/database'
import {
  type BulkLabelsBody,
  CarrierCapability,
  BulkLabelJobStatus,
  BulkLabelLimits,
  type MergeLabelsBody,
  ShipmentResourceTypes
} from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  type BulkLabelsMergeJob,
  bulkLabelsMergeJobId,
  JobNames,
  QueueNames
} from '@platform/core/queues'
import { type BulkResultEntry, MergedLabels } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { CarrierConnectionsService } from '../carriers/carrier-connections.service'
import type { Actor } from '../tenancy'

import type { BulkJobRow, BulkJobView, FileLinkView, LabelMergeView } from './bulk-labels.views'

const JOB_SELECT = {
  id: true,
  status: true,
  total: true,
  succeeded: true,
  failed: true,
  results: true,
  createdAt: true,
  finishedAt: true
} as const

const BULK_RUN_LOCK_SCOPE = 'bulk_labels_runs'
const HOUR_MS = 60 * 60 * 1000

function resultsOf(value: unknown): BulkResultEntry[] | null {
  return Array.isArray(value) ? (value as BulkResultEntry[]) : null
}

// The labels of many orders at once (TDD_17 §4.6): the request that starts a run, the read of how it is going, and the print of
// guides that already exist. The permission of each route is checked by the controller, and the store is the one TenantGuard resolved.
@Injectable()
export class BulkLabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merged: MergedLabels,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    private readonly registry: CarrierRegistry,
    private readonly carriers: CarrierConnectionsService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<BulkLabelsMergeJob>
  ) {
    this.logger.setContext(BulkLabelsService.name)
  }

  // The places of a run, by the capability of the carrier and never by its name: a carrier that asks for them (REQUIRES_LOCATION_IDS)
  // gets both, each one of the list that carrier gives for its parent (the same cached list the selectors read, so the check
  // costs no call to the carrier in the common case); a carrier that does not ask for them takes none, because the places of
  // another carrier would travel in every guide.
  private async assertPlaces(
    storeId: string,
    connection: { id: string; carrierId: string },
    locationIds: BulkLabelsBody['locationIds']
  ): Promise<void> {
    const asks = this.registry.hasCapability(
      connection.carrierId,
      CarrierCapability.REQUIRES_LOCATION_IDS
    )
    if (!asks) {
      if (locationIds === undefined) return
      throw new PlatformException(
        ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING,
        'the carrier takes no places',
        HttpStatusCodes.CONFLICT
      )
    }
    if (locationIds === undefined) {
      throw new PlatformException(
        ErrorCodes.SHIPPING_LOCATION_REQUIRED,
        'the carrier needs location ids',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const departments = await this.carriers.locations(storeId, connection.id, {})
    const department = departments.some(place => place.id === locationIds.departmentId)
    const municipalities = department
      ? await this.carriers.locations(storeId, connection.id, {
          parentId: locationIds.departmentId
        })
      : []
    if (!municipalities.some(place => place.id === locationIds.municipalityId)) {
      throw new PlatformException(
        ErrorCodes.SHIPPING_LOCATION_REQUIRED,
        'the places are not in the list of the carrier',
        HttpStatusCodes.BAD_REQUEST
      )
    }
  }

  // POST /shipments/bulk: writes the run down and queues it; the worker does the rest and says how it went as it goes. An order
  // that does not qualify is not refused here: the run reports it with its reason, like every other order.
  async request(
    storeId: string,
    body: BulkLabelsBody,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<BulkJobView> {
    // A carrier of another store is a 404 now, not a skip of every order later; places a carrier needs (or does not take) are
    // judged now too, once, so that the run does not refuse every order of the batch one by one
    if (body.connectionId !== undefined) {
      const connection = await this.prisma.client.carrierConnection.findFirst({
        where: { id: body.connectionId, storeId },
        select: { id: true, carrierId: true }
      })
      if (connection === null) throw resourceNotFound('carrier')
      await this.assertPlaces(storeId, connection, body.locationIds)
    }
    // Runs that have not ended hold the queue of the heavy jobs, which also scans every file: a store has only so many at once. The
    // count and the write take turns, so that requests made together cannot all pass the count; a run older than the time the
    // cleanup gives it was lost, and does not count.
    const row = await this.prisma.transaction(async tx => {
      await lockStoreScope(tx, storeId, BULK_RUN_LOCK_SCOPE)
      const active = await tx.bulkLabelJob.count({
        where: {
          storeId,
          status: { in: [BulkLabelJobStatus.QUEUED, BulkLabelJobStatus.RUNNING] },
          createdAt: { gt: new Date(Date.now() - BulkLabelLimits.STALE_JOB_HOURS * HOUR_MS) }
        }
      })
      if (active >= BulkLabelLimits.MAX_ACTIVE_RUNS) {
        throw new PlatformException(
          ErrorCodes.RATE_LIMIT_EXCEEDED,
          'too many bulk runs of labels are under way',
          HttpStatusCodes.TOO_MANY_REQUESTS,
          { [RETRY_AFTER_METADATA_KEY]: BulkLabelLimits.RETRY_AFTER_SECONDS }
        )
      }
      return tx.bulkLabelJob.create({
        data: {
          storeId,
          status: BulkLabelJobStatus.QUEUED,
          orderIds: body.orderIds,
          total: body.orderIds.length,
          requestedBy: actor.userId
        },
        select: JOB_SELECT
      })
    })
    try {
      await this.queue.add(
        JobNames.BULK_LABELS_MERGE,
        {
          storeId,
          jobId: row.id,
          ...(body.connectionId === undefined ? {} : { connectionId: body.connectionId }),
          ...(body.locationIds === undefined ? {} : { locationIds: body.locationIds }),
          ...(body.pickup === undefined ? {} : { pickup: body.pickup }),
          canOverridePrice: held.includes(Permissions.ORDERS_OVERRIDE_PRICE)
        },
        { jobId: bulkLabelsMergeJobId(row.id), attempts: BulkLabelLimits.JOB_ATTEMPTS }
      )
    } catch (error) {
      // Nothing will ever run it: closed as failed, so that the screen does not wait for it
      this.logger.error(
        { jobId: row.id, errorName: errorName(error) },
        'a bulk run could not be queued'
      )
      await this.prisma.client.bulkLabelJob.updateMany({
        where: { id: row.id, storeId, status: BulkLabelJobStatus.QUEUED },
        data: { status: BulkLabelJobStatus.FAILED, finishedAt: new Date() }
      })
      throw error
    }
    this.audit.log({
      action: AuditAction.BULK_LABELS_REQUESTED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ShipmentResourceTypes.BULK_LABEL_JOB,
      resourceId: row.id,
      metadata: {
        orders: body.orderIds.length,
        ...(body.connectionId === undefined ? {} : { connectionId: body.connectionId })
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.view(storeId, row)
  }

  // GET /shipments/bulk/:jobId
  async get(storeId: string, jobId: string, userId: string): Promise<BulkJobView> {
    const row = await this.prisma.client.bulkLabelJob.findFirst({
      where: { id: jobId, storeId, requestedBy: userId },
      select: { ...JOB_SELECT, mergedMediaId: true }
    })
    if (row === null) throw resourceNotFound(ShipmentResourceTypes.BULK_LABEL_JOB)
    return this.view(storeId, row, row.mergedMediaId)
  }

  // POST /shipments/labels/merge: the stored labels of these guides in one file, with no call to a carrier. A voided label is not
  // in it and is reported. The guides are the store's own: another store's is "not found" in the report, like one that does not exist.
  async merge(storeId: string, body: MergeLabelsBody, actor: Actor): Promise<LabelMergeView> {
    const outcome = await this.merged.build(storeId, body.shipmentIds, {
      requestedBy: actor.userId,
      waitForScan: false
    })
    const download: FileLinkView | null =
      outcome.file === null ? null : await this.merged.download(storeId, outcome.file.mediaId)
    // Who printed the labels of which guides is on the trail: the file holds the customers of every one of them
    this.audit.log({
      action: AuditAction.SHIPMENT_LABELS_MERGED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ShipmentResourceTypes.SHIPMENT,
      metadata: {
        ...(outcome.file === null ? {} : { mediaId: outcome.file.mediaId }),
        asked: body.shipmentIds.length,
        merged: outcome.file?.merged.length ?? 0,
        leftOut: outcome.leftOut.length
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return {
      download,
      merged: outcome.file?.merged ?? [],
      leftOut: outcome.leftOut,
      pageCount: outcome.file?.pageCount ?? 0,
      mixedSizes: outcome.file?.mixedSizes ?? false
    }
  }

  private async view(
    storeId: string,
    row: BulkJobRow,
    mergedMediaId: string | null = null
  ): Promise<BulkJobView> {
    const download =
      mergedMediaId === null ? null : await this.merged.download(storeId, mergedMediaId)
    return {
      id: row.id,
      status: row.status as BulkLabelJobStatus,
      total: row.total,
      succeeded: row.succeeded,
      failed: row.failed,
      results: resultsOf(row.results),
      download,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null
    }
  }
}
