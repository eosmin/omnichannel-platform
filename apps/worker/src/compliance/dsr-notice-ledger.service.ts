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

  // The mail job ran out of attempts in the mail queue. The count of the tries of the notice is written when the notice is QUEUED (it is
  // persisted before the mail is processed, so a job that never reaches the processor is counted too: `DsrNoticeSender.send`), so this only
  // marks the failure and frees the notice to be queued again. A request with no address left, or with its tries spent, is given up here.
  async failed(storeId: string, requestId: string, code: string): Promise<void> {
    const final = await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        const done = await tx.dataSubjectRequest.updateMany({
          where: {
            id: requestId,
            storeId,
            noticeSentAt: null,
            // A request that was never verified has no closing notice to fail
            status: { not: DsrStatus.PENDING_VERIFICATION }
          },
          data: { noticeFailedAt: new Date(), noticeQueuedAt: null }
        })
        if (done.count !== 1) return false
        const row = await tx.dataSubjectRequest.findFirstOrThrow({
          where: { id: requestId, storeId },
          select: { noticeAttempts: true, notifyToEncrypted: true }
        })
        return (
          row.notifyToEncrypted === null ||
          row.noticeAttempts >= ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS
        )
      })
    )
    this.logger.warn({ requestId, code }, 'the closing notice of a data request failed')
    if (final) await this.giveUp(storeId, requestId, code)
  }

  // The person will not be told by mail: the address is cleared (it is not kept for ever), the request says so, and the reviewers are told ONCE.
  // Used when the mail failed its last attempt, when the address does not open (a key that changed) and when a notice that was queued was never
  // confirmed nor failed (the job was lost) for longer than `DSR_NOTICE_STALE_HOURS`.
  async giveUp(storeId: string, requestId: string, reason: string): Promise<void> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(async tx => {
        const done = await tx.dataSubjectRequest.updateMany({
          where: {
            id: requestId,
            storeId,
            noticeSentAt: null,
            // The compare-and-swap of the giving up: a second run finds the notice already failed
            OR: [{ noticeFailedAt: null }, { notifyToEncrypted: { not: null } }]
          },
          data: {
            noticeFailedAt: new Date(),
            noticeAttempts: ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS,
            noticeQueuedAt: null,
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
          metadata: { type: row.type, reason }
        })
        this.events.publish(tx, Events.DSR_NOTICE_FAILED, {
          storeId,
          requestId,
          type: row.type,
          reason
        })
      })
    )
  }

  // An address that could not be opened can never be mailed: the same end, at once, without waiting for attempts
  unreadable(storeId: string, requestId: string): Promise<void> {
    return this.giveUp(storeId, requestId, DsrFailureCodes.ADDRESS_UNREADABLE)
  }
}
