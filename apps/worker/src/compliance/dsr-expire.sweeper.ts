import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  dsrNoticeJob,
  dsrNoticeLocaleOf,
  DsrFailureCodes,
  DsrRejectionReasons,
  DsrResultOutcomes,
  openDsrNotifyAddress,
  DsrResourceTypes
} from '@platform/core/compliance'
import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { DsrStatus, VerificationTokenType } from '@platform/core/domain'
import { type SealedMailJobData, sealMailJob } from '@platform/core/email'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import type { Locale } from '@platform/core/i18n'
import { QueueNames, type SendEmailJob } from '@platform/core/queues'

import { inEachStoreStrict } from '../schedulers/store-sweep'

// rls-context: the stores are listed from `stores`; every read and write of a request, a token or a customer runs inside JobContext.forStore

export interface DsrExpireReport {
  expired: number
  failed: number
}

// The requests that were never confirmed (Step 7.2-H1b). A request waits for the link of its mail; when the link expires unused the person has
// to ask again (nothing is resent by itself), so the request closes as rejected, the sealed address and its hash are cleared, and the person
// is told. It touches no customer and writes nothing about one: nothing was verified, so nothing was approved.
@Injectable()
export class DsrExpireSweeper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    @InjectQueue(QueueNames.EMAIL)
    private readonly emailQueue: Queue<SendEmailJob | SealedMailJobData>,
    private readonly cipher: CredentialCipher,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrExpireSweeper.name)
  }

  async run(now: Date = new Date()): Promise<DsrExpireReport> {
    const report: DsrExpireReport = { expired: 0, failed: 0 }
    await inEachStoreStrict(this.prisma, async storeId => {
      const done = await this.sweepStore(storeId, now)
      report.expired += done.expired
      report.failed += done.failed
    })
    return report
  }

  private async sweepStore(storeId: string, now: Date): Promise<DsrExpireReport> {
    const candidates = await this.jobContext.forStore(storeId, () =>
      this.candidatesOf(storeId, now)
    )
    const report: DsrExpireReport = { expired: 0, failed: 0 }
    for (const candidate of candidates) {
      // One request that cannot be closed (the queue is down) does not keep the others open: it stays waiting for the next run
      try {
        const closed = await this.jobContext.forStore(storeId, () =>
          this.expire(storeId, candidate, now)
        )
        if (closed === null) continue
        report.expired += 1
        this.audit.log({
          action: AuditAction.DSR_EXPIRED,
          actor: { system: true },
          storeId,
          organizationId: closed.organizationId,
          resourceType: DsrResourceTypes.REQUEST,
          resourceId: closed.id,
          metadata: { type: closed.type }
        })
      } catch (error) {
        report.failed += 1
        this.logger.error(
          { requestId: candidate, errorName: errorName(error) },
          'a data request whose verification expired could not be closed'
        )
      }
    }
    return report
  }

  // Waiting for a link that no longer works: no token of the request is unused and unexpired
  private candidatesOf(storeId: string, now: Date): Promise<string[]> {
    return this.prisma
      .transaction(
        tx =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT r.id FROM data_subject_requests r
          WHERE r.store_id = ${storeId} AND r.status = ${DsrStatus.PENDING_VERIFICATION}
            AND NOT EXISTS (
              SELECT 1 FROM verification_tokens t
              WHERE t.type = ${VerificationTokenType.DSR_VERIFICATION} AND t.subject = r.id
                AND t.used_at IS NULL AND t.expires_at > ${now})
          ORDER BY r.requested_at
          LIMIT ${ComplianceConfig.DSR_EXPIRE_BATCH}`
      )
      .then(rows => rows.map(row => row.id))
  }

  // One request, one transaction: the row is locked and looked at again (the person may have confirmed in the meantime), the address is read
  // and cleared, and the mail is queued before the transaction ends, so a mail that cannot be queued leaves the request as it was.
  private expire(
    storeId: string,
    requestId: string,
    now: Date
  ): Promise<{ id: string; type: string; organizationId: string } | null> {
    return this.prisma.transaction(async tx => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT r.id FROM data_subject_requests r
        WHERE r.id = ${requestId} AND r.store_id = ${storeId} AND r.status = ${DsrStatus.PENDING_VERIFICATION}
          AND NOT EXISTS (
            SELECT 1 FROM verification_tokens t
            WHERE t.type = ${VerificationTokenType.DSR_VERIFICATION} AND t.subject = r.id
              AND t.used_at IS NULL AND t.expires_at > ${now})
        FOR UPDATE OF r SKIP LOCKED`
      if (locked.length === 0) return null
      const row = await tx.dataSubjectRequest.findFirstOrThrow({
        where: { id: requestId, storeId },
        select: { type: true, organizationId: true, notifyToEncrypted: true, noticeLocale: true }
      })
      const done = await tx.dataSubjectRequest.updateMany({
        where: { id: requestId, storeId, status: DsrStatus.PENDING_VERIFICATION },
        data: {
          status: DsrStatus.REJECTED,
          rejectionReason: DsrRejectionReasons.VERIFICATION_EXPIRED,
          completedAt: now,
          notifyToEncrypted: null,
          subjectEmailHash: null
        }
      })
      if (done.count !== 1) return null
      const to =
        row.notifyToEncrypted === null
          ? null
          : openDsrNotifyAddress(
              row.notifyToEncrypted,
              this.config.encryptionKeyHex,
              this.config.previousEncryptionKeyHex
            )
      // An address that does not open (a key that changed) is not mailed, and must not keep the request open for ever
      if (row.notifyToEncrypted !== null && to === null) {
        this.logger.error({ requestId }, 'the address of a data request could not be opened')
        // Said, not silent: the request shows that the person was never told
        await tx.dataSubjectRequest.updateMany({
          where: { id: requestId, storeId },
          data: { noticeFailedAt: now, noticeAttempts: ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS }
        })
        this.audit.log({
          action: AuditAction.DSR_NOTICE_FAILED,
          actor: { system: true },
          storeId,
          organizationId: row.organizationId,
          resourceType: DsrResourceTypes.REQUEST,
          resourceId: requestId,
          metadata: { type: row.type, reason: DsrFailureCodes.ADDRESS_UNREADABLE }
        })
        this.events.publish(tx, Events.DSR_NOTICE_FAILED, {
          storeId,
          requestId,
          type: row.type,
          reason: DsrFailureCodes.ADDRESS_UNREADABLE
        })
      }
      if (to !== null) {
        const store = await tx.store.findUnique({
          where: { id: storeId },
          select: { defaultLocale: true }
        })
        const locale: Locale = dsrNoticeLocaleOf(row.noticeLocale, store?.defaultLocale)
        const job = dsrNoticeJob({
          requestId,
          storeId,
          to,
          locale,
          outcome: DsrResultOutcomes.EXPIRED,
          requestType: row.type
        })
        await this.emailQueue.add(job.name, sealMailJob(this.cipher, job.data), job.opts)
        await tx.dataSubjectRequest.updateMany({
          where: { id: requestId, storeId },
          data: { noticeQueuedAt: new Date(), noticeAttempts: { increment: 1 } }
        })
      }
      return { id: requestId, type: row.type, organizationId: row.organizationId }
    })
  }
}
