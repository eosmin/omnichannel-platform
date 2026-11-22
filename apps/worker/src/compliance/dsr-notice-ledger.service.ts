import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig, DsrFailureCodes, DsrResourceTypes } from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { DsrStatus } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

// rls-context: every read and write of a request runs inside JobContext.forStore

// What the mail processor tells the request about its closing notice (Step 7.2-H2b-2). A person has a right to be told what became of their
// request (TDD_05 §10.3), so the notice is never "queued and forgotten": the processor confirms it here, or says it ran out of attempts.
//
// - `sent`: the mail was handed to the provider. The sealed address (kept until now by an erasure, whose person can no longer be found in the
//   customers) is cleared in the same statement that records it.
// - `failed`: the mail ran out of attempts. The request is marked. An ended erasure still holds its sealed address, so the sweep queues the mail
//   again on the next nights (`DSR_NOTICE_MAX_ATTEMPTS` in all); a request with no address left (a rejection, an expiry, an erasure out of
//   tries) is final: the reviewers are told, once, to reach the person another way. The audit and the event hold ids and a code, never the address.
@Injectable()
export class DsrNoticeLedger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrNoticeLedger.name)
  }

  async sent(storeId: string, requestId: string): Promise<void> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        // Compare-and-swap on the state: a second confirmation, or one that arrives after the person was given up on, changes nothing
        await tx.dataSubjectRequest.updateMany({
          where: { id: requestId, storeId, noticeSentAt: null },
          data: { noticeSentAt: new Date(), noticeFailedAt: null, notifyToEncrypted: null }
        })
      })
    )
  }

  async failed(storeId: string, requestId: string, code: string): Promise<void> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        const done = await tx.dataSubjectRequest.updateMany({
          where: { id: requestId, storeId, noticeSentAt: null },
          data: {
            noticeFailedAt: new Date(),
            noticeAttempts: { increment: 1 },
            noticeQueuedAt: null
          }
        })
        if (done.count !== 1) return
        const row = await tx.dataSubjectRequest.findFirstOrThrow({
          where: { id: requestId, storeId },
          select: {
            organizationId: true,
            type: true,
            status: true,
            noticeAttempts: true,
            notifyToEncrypted: true
          }
        })
        // A request that was not ended has no closing notice to give up on (a mail of another kind was marked by mistake): nothing more to do
        if (row.status === String(DsrStatus.PENDING_VERIFICATION)) return
        const retry =
          row.notifyToEncrypted !== null &&
          row.noticeAttempts < ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS
        if (retry) return
        // Final: the address is not kept for ever
        await tx.dataSubjectRequest.updateMany({
          where: { id: requestId, storeId, noticeSentAt: null },
          data: { notifyToEncrypted: null }
        })
        this.audit.log({
          action: AuditAction.DSR_NOTICE_FAILED,
          actor: { system: true },
          storeId,
          organizationId: row.organizationId,
          resourceType: DsrResourceTypes.REQUEST,
          resourceId: requestId,
          metadata: { type: row.type, reason: code, attempts: row.noticeAttempts }
        })
        this.events.publish(tx, Events.DSR_NOTICE_FAILED, {
          storeId,
          requestId,
          type: row.type,
          reason: code
        })
      })
    )
    this.logger.warn(
      { requestId, code },
      'the closing notice of a data request ran out of attempts'
    )
  }

  // An address that could not be opened (a key that changed) can never be mailed: the same end, at once, without waiting for attempts
  async unreadable(storeId: string, requestId: string): Promise<void> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        const done = await tx.dataSubjectRequest.updateMany({
          where: { id: requestId, storeId, noticeSentAt: null },
          data: {
            noticeFailedAt: new Date(),
            noticeAttempts: ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS,
            notifyToEncrypted: null
          }
        })
        if (done.count !== 1) return
        const row = await tx.dataSubjectRequest.findFirstOrThrow({
          where: { id: requestId, storeId },
          select: { organizationId: true, type: true }
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
      })
    )
  }
}
