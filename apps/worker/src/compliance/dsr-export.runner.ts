import { Inject, Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  DsrErasureReturnReasons,
  DsrFailureCodes,
  DsrResourceTypes,
  LegalBases
} from '@platform/core/compliance'
import { checkDsrSubject } from '@platform/core/customer-erasure'
import {
  JobContext,
  JobContextGoneError,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { DAY_MS, DsrStatus, DsrType } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { ExportContentTypes } from '@platform/core/exports'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { allStoreIds } from '../schedulers/store-sweep'

import { collectDsrExport, DsrExportTooLargeError, zipDsrExport } from './dsr-export-data'
import { DsrNoticeSender } from './dsr-notice-sender.service'

// rls-context: the stores are listed from `stores`; every read and write of a request and of a customer runs inside JobContext.forStore

const EXPORT_TYPES: readonly string[] = [DsrType.ACCESS, DsrType.PORTABILITY]

export interface DsrExportReport {
  exported: number
  returned: number
  purged: number
  notified: number
  failed: number
  skipped: number
}

// The export of an approved access or portability request, and the purge of the ones that expired (TDD_05 §10.1, Step 7.2-H2b-2). A daily
// sweep of the worker (no job with a payload: nothing personal ever sits in the queue). A request is taken like the erasure of H2b-1: ONE
// conditional UPDATE counts the try and takes the lease (the state, the tries and the lease are in its WHERE), then the work runs under the
// lock of the row and looks at everything again, so two sweeps and a reviewer taking turns cannot export, or give back, twice.
//
// What goes into the file is `collectDsrExport` (the customers the request names, by store AND id). The file is one ZIP in the bucket, under a
// key of the request, kept `DSR_EXPORT_LINK_DAYS` days; the reviewer asks the api for a short signed link to it (never bytes through the api),
// and the purge below deletes the object when the date passes.
@Injectable()
export class DsrExportRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly storage: StorageService,
    private readonly notices: DsrNoticeSender,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrExportRunner.name)
  }

  async run(
    until: number = Number.POSITIVE_INFINITY,
    now: Date = new Date()
  ): Promise<DsrExportReport> {
    const report: DsrExportReport = {
      exported: 0,
      returned: 0,
      purged: 0,
      notified: 0,
      failed: 0,
      skipped: 0
    }
    for (const storeId of await allStoreIds(this.prisma)) {
      if (Date.now() > until) break
      try {
        await this.sweepStore(storeId, now, until, report)
      } catch (error) {
        if (error instanceof JobContextGoneError) continue
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'the export of data requests could not enter a store'
        )
      }
    }
    this.logger.info(report, 'the sweep of data exports finished')
    return report
  }

  private async sweepStore(
    storeId: string,
    now: Date,
    until: number,
    report: DsrExportReport
  ): Promise<void> {
    // Each phase on its own: one that fails must not keep the others (the legal deadline runs) from happening tonight
    const phase = async (work: () => Promise<void>): Promise<void> => {
      try {
        await work()
      } catch (error) {
        if (error instanceof JobContextGoneError) throw error
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'a phase of the export of data requests failed'
        )
      }
    }
    await phase(async () => {
      report.purged += await this.purgeExpired(storeId, now)
    })
    await phase(async () => {
      report.returned += await this.returnExhausted(storeId)
    })
    await phase(async () => {
      const sent = await this.notices.sendPending(storeId)
      report.notified += sent.queued
      report.failed += sent.failed
    })
    const candidates = await this.jobContext.forStore(storeId, () => this.candidatesOf(storeId))
    for (const requestId of candidates) {
      if (Date.now() > until) return
      await this.exportOne(storeId, requestId, now, report)
    }
  }

  private leaseEnd(): Date {
    return new Date(Date.now() - ComplianceConfig.DSR_EXPORT_LEASE_MS)
  }

  private candidatesOf(storeId: string): Promise<string[]> {
    return this.prisma
      .transaction(tx =>
        tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            type: { in: [...EXPORT_TYPES] },
            status: DsrStatus.IN_PROGRESS,
            resultKey: null,
            exportAttempts: { lt: ComplianceConfig.DSR_EXPORT_MAX_ATTEMPTS },
            OR: [{ exportAttemptedAt: null }, { exportAttemptedAt: { lt: this.leaseEnd() } }]
          },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
          take: ComplianceConfig.DSR_EXPORT_BATCH,
          select: { id: true }
        })
      )
      .then(rows => rows.map(row => row.id))
  }

  // The count of the try is written and committed BEFORE the work: a request that kills the process every time stops being taken
  private claim(storeId: string, requestId: string): Promise<boolean> {
    return this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        const done = await tx.dataSubjectRequest.updateMany({
          where: {
            id: requestId,
            storeId,
            type: { in: [...EXPORT_TYPES] },
            status: DsrStatus.IN_PROGRESS,
            resultKey: null,
            exportAttempts: { lt: ComplianceConfig.DSR_EXPORT_MAX_ATTEMPTS },
            OR: [{ exportAttemptedAt: null }, { exportAttemptedAt: { lt: this.leaseEnd() } }]
          },
          data: { exportAttempts: { increment: 1 }, exportAttemptedAt: new Date() }
        })
        return done.count === 1
      })
    )
  }

  private async exportOne(
    storeId: string,
    requestId: string,
    now: Date,
    report: DsrExportReport
  ): Promise<void> {
    if (!(await this.claim(storeId, requestId))) {
      report.skipped += 1
      return
    }
    try {
      const outcome = await this.jobContext.forStore(
        storeId,
        () => this.build(storeId, requestId, now),
        { timeout: ComplianceConfig.DSR_ERASE_TRANSACTION_TIMEOUT_MS }
      )
      if (outcome === 'skipped') {
        report.skipped += 1
      } else if (outcome === 'returned') {
        report.returned += 1
      } else {
        report.exported += 1
        const notice = await this.notices.send(storeId, requestId)
        if (notice === 'queued') report.notified += 1
        if (notice === 'failed') report.failed += 1
      }
    } catch (error) {
      report.failed += 1
      // The name only: the message of an error can hold a fragment of the data
      const code =
        error instanceof DsrExportTooLargeError ? error.code : DsrFailureCodes.EXPORT_FAILED
      this.logger.error(
        { storeId, requestId, errorName: errorName(error) },
        'the export of a data request failed'
      )
      // The object may have been written before the transaction failed: no row points at it, so it goes now (a failure to delete is logged)
      await this.storage.delete(StorageKeys.dsrExport(requestId)).catch((deleteError: unknown) => {
        this.logger.error(
          { storeId, requestId, errorName: errorName(deleteError) },
          'the file of a failed data export could not be deleted'
        )
      })
      // A file too large will be too large tomorrow: back to the reviewers at once, not after three tries
      if (
        await this.recordFailure(storeId, requestId, code, error instanceof DsrExportTooLargeError)
      ) {
        report.returned += 1
      }
    }
  }

  private async build(
    storeId: string,
    requestId: string,
    now: Date
  ): Promise<'exported' | 'returned' | 'skipped'> {
    return this.prisma.transaction(async tx => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM data_subject_requests
        WHERE id = ${requestId} AND store_id = ${storeId} AND type = ANY(${[...EXPORT_TYPES]}::text[])
          AND status = ${DsrStatus.IN_PROGRESS} AND result_key IS NULL
        FOR UPDATE SKIP LOCKED`
      if (locked.length === 0) return 'skipped'
      const row = await tx.dataSubjectRequest.findFirstOrThrow({
        where: { id: requestId, storeId },
        select: {
          type: true,
          organizationId: true,
          subjectCustomerIds: true,
          subjectEmailHash: true
        }
      })
      // The customers still are the people that asked: an address that moved to another person, or a customer erased or merged since, is a
      // decision for a reviewer. An erased customer has nothing left to give, and a merged one would bring in the data of someone else.
      const subject = await checkDsrSubject(
        tx,
        storeId,
        row.subjectCustomerIds,
        row.subjectEmailHash,
        this.config.hashKey
      )
      if (!subject.same || subject.pending.length !== row.subjectCustomerIds.length) {
        await this.giveBack(
          tx,
          storeId,
          row.organizationId,
          requestId,
          row.type,
          DsrErasureReturnReasons.SUBJECT_CHANGED
        )
        return 'returned'
      }
      const content = await collectDsrExport(tx, storeId, row.subjectCustomerIds)
      const zip = await zipDsrExport(content, { type: row.type, generatedAt: now })
      const key = StorageKeys.dsrExport(requestId)
      // The object first, the row after: a death in between leaves an object the next try overwrites (same key) and a request still in progress
      await this.storage.put(key, zip, ExportContentTypes.ZIP)
      const done = await tx.dataSubjectRequest.updateMany({
        where: { id: requestId, storeId, status: DsrStatus.IN_PROGRESS, resultKey: null },
        data: {
          status: DsrStatus.COMPLETED,
          completedAt: now,
          resultKey: key,
          resultExpiresAt: new Date(now.getTime() + ComplianceConfig.DSR_EXPORT_LINK_DAYS * DAY_MS),
          retainedRecordsSummary: { legalBasis: LegalBases.LEGAL_OBLIGATION, ...content.counts },
          exportFailureCode: null,
          subjectEmailHash: null
        }
      })
      if (done.count !== 1) throw new Error('the data request changed under its lock')
      this.audit.log({
        action: AuditAction.DSR_EXPORT_COMPLETED,
        actor: { system: true },
        storeId,
        organizationId: row.organizationId,
        resourceType: DsrResourceTypes.REQUEST,
        resourceId: requestId,
        // Ids and counts: never the data, never an address
        metadata: { type: row.type, counts: content.counts, bytes: zip.length }
      })
      return 'exported'
    })
  }

  // Back to the review queue with a code. Used when the data is not what was approved (not a failure of ours): the tries are not spent
  private async giveBack(
    tx: PrismaTransaction,
    storeId: string,
    organizationId: string,
    requestId: string,
    type: string,
    reason: string
  ): Promise<void> {
    const done = await tx.dataSubjectRequest.updateMany({
      where: { id: requestId, storeId, status: DsrStatus.IN_PROGRESS },
      data: {
        status: DsrStatus.MANUAL_REVIEW,
        approvals: [],
        exportAttempts: 0,
        exportAttemptedAt: null,
        exportFailureCode: reason
      }
    })
    if (done.count !== 1) return
    this.audit.log({
      action: AuditAction.DSR_EXPORT_FAILED,
      actor: { system: true },
      storeId,
      organizationId,
      resourceType: DsrResourceTypes.REQUEST,
      resourceId: requestId,
      metadata: { type, reason }
    })
    this.events.publish(tx, Events.DSR_RETURNED_TO_REVIEW, { storeId, requestId, type, reason })
  }

  // A failed try is written in its own transaction (the one that failed rolled back). The request goes back to the review queue when it used its
  // last try (or at once when `final`); before that it waits for the next night.
  private async recordFailure(
    storeId: string,
    requestId: string,
    code: string,
    final: boolean
  ): Promise<boolean> {
    try {
      return await this.jobContext.forStore(storeId, () =>
        this.prisma.transaction(async tx => {
          await tx.dataSubjectRequest.updateMany({
            where: { id: requestId, storeId, status: DsrStatus.IN_PROGRESS },
            data: { exportFailureCode: code }
          })
          const row = await tx.dataSubjectRequest.findFirst({
            where: {
              id: requestId,
              storeId,
              status: DsrStatus.IN_PROGRESS,
              ...(final
                ? {}
                : { exportAttempts: { gte: ComplianceConfig.DSR_EXPORT_MAX_ATTEMPTS } })
            },
            select: { organizationId: true, type: true }
          })
          if (row === null) return false
          await this.giveBack(tx, storeId, row.organizationId, requestId, row.type, code)
          return true
        })
      )
    } catch (error) {
      this.logger.error(
        { storeId, requestId, errorName: errorName(error) },
        'the failure of an export could not be recorded'
      )
      return false
    }
  }

  // An export that used all its tries without ending (the last one killed the process, so no one recorded the failure) goes back to review
  private async returnExhausted(storeId: string): Promise<number> {
    return this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        const rows = await tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            type: { in: [...EXPORT_TYPES] },
            status: DsrStatus.IN_PROGRESS,
            resultKey: null,
            exportAttempts: { gte: ComplianceConfig.DSR_EXPORT_MAX_ATTEMPTS },
            OR: [{ exportAttemptedAt: null }, { exportAttemptedAt: { lt: this.leaseEnd() } }]
          },
          orderBy: { requestedAt: 'asc' },
          take: ComplianceConfig.DSR_EXPORT_BATCH,
          select: { id: true, organizationId: true, type: true }
        })
        for (const row of rows) {
          await this.giveBack(
            tx,
            storeId,
            row.organizationId,
            row.id,
            row.type,
            DsrFailureCodes.EXPORT_FAILED
          )
        }
        return rows.length
      })
    )
  }

  // The file of an export whose link date passed is deleted and the key cleared. The object goes first (deleting a missing key is not an
  // error); the key is cleared only if it is still the same one, so a second run does nothing.
  private async purgeExpired(storeId: string, now: Date): Promise<number> {
    const due = await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(tx =>
        tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            type: { in: [...EXPORT_TYPES] },
            resultKey: { not: null },
            resultExpiresAt: { lte: now }
          },
          orderBy: [{ resultExpiresAt: 'asc' }, { id: 'asc' }],
          take: ComplianceConfig.DSR_EXPORT_BATCH,
          select: { id: true, organizationId: true, type: true, resultKey: true }
        })
      )
    )
    let purged = 0
    for (const row of due) {
      if (row.resultKey === null) continue
      try {
        await this.storage.delete(row.resultKey)
        const done = await this.jobContext.forStore(storeId, () =>
          this.prisma.transaction(async tx => {
            const cleared = await tx.dataSubjectRequest.updateMany({
              where: { id: row.id, storeId, resultKey: row.resultKey },
              data: { resultKey: null }
            })
            if (cleared.count === 1) {
              this.audit.log({
                action: AuditAction.DSR_EXPORT_PURGED,
                actor: { system: true },
                storeId,
                organizationId: row.organizationId,
                resourceType: DsrResourceTypes.REQUEST,
                resourceId: row.id,
                metadata: { type: row.type }
              })
            }
            return cleared.count === 1
          })
        )
        if (done) purged += 1
      } catch (error) {
        this.logger.error(
          { storeId, requestId: row.id, errorName: errorName(error) },
          'the file of an expired data export could not be deleted; the next run tries again'
        )
      }
    }
    return purged
  }
}
