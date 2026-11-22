import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  DsrErasureReturnReasons,
  type DsrErasureReturnReason,
  DsrResourceTypes,
  DsrResultOutcomes,
  LegalBases,
  hasOpenWork,
  openDsrNotifyAddress,
  type DsrOpenWork
} from '@platform/core/compliance'
import {
  checkDsrSubject,
  CustomerErasureService,
  DsrOpenWorkService
} from '@platform/core/customer-erasure'
import {
  JobContext,
  JobContextGoneError,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { type Actor, DsrStatus, DsrType } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import {
  dsrResultMailJobId,
  EmailTemplates,
  JobNames,
  QueueNames,
  type SendEmailJob
} from '@platform/core/queues'

import { allStoreIds } from '../schedulers/store-sweep'

// rls-context: the stores are listed from `stores`; every read and write of a request and of a customer runs inside JobContext.forStore

// The label of the actor of the sweep: never a row of `users` (the audit records the system, and `auditActorOf` never reads it)
const SYSTEM_ACTOR_LABEL = 'system:dsr-erase-due'

export interface DsrEraseReport {
  // Erasures finished, given back to the review queue, and tries that failed (the request waits for the next night)
  completed: number
  returned: number
  // Closing mails queued for requests that ended (this night's and any whose queue was down before)
  notified: number
  failed: number
  // A request the sweep did not take: it ended, was cancelled, or another run holds it
  skipped: number
}

type Attempt =
  | { kind: 'skipped' }
  | {
      kind: 'completed'
      organizationId: string
      customers: number
      retained: { orders: number; conversations: number }
    }
  | {
      kind: 'returned'
      organizationId: string
      reason: DsrErasureReturnReason
      openWork: DsrOpenWork | null
    }

// The erasure of an approved data request, when its grace period ends (TDD_05 §10.3, Step 7.2-H2b-1). A daily sweep of the worker, the only
// caller of the erasure service (`dsr-erase-due-static.spec.ts` keeps it so: no job with a payload can erase a customer).
//
// A request is taken in TWO transactions. The first claims it with one conditional UPDATE that also counts the try (the state, the date, the
// number of tries and the lease are all in its WHERE, so two sweeps never take the same one) and commits at once: a request that kills the
// process every time is counted and stops being taken. The second does the work under the lock of the row, looks at everything again
// (cancelled? the customers still the people that asked? open work that appeared since the approval?) and erases ALL the customers and ends
// the request in that one transaction: it is all or nothing, so no one is left half erased without the request knowing.
@Injectable()
export class DsrEraseDueSweeper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly audit: AuditService,
    private readonly erasure: CustomerErasureService,
    private readonly openWork: DsrOpenWorkService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrEraseDueSweeper.name)
  }

  // `until`: the moment (epoch ms) after which it starts no other request, so a long backlog never outlasts the lock of the daily run
  async run(
    until: number = Number.POSITIVE_INFINITY,
    now: Date = new Date()
  ): Promise<DsrEraseReport> {
    const report: DsrEraseReport = { completed: 0, returned: 0, notified: 0, failed: 0, skipped: 0 }
    // A store that cannot be entered deletes nothing and waits for tomorrow: this sweep acts only on requests that are due, it never decides by
    // what it does not find
    for (const storeId of await allStoreIds(this.prisma)) {
      if (Date.now() > until) break
      try {
        await this.sweepStore(storeId, now, until, report)
      } catch (error) {
        if (error instanceof JobContextGoneError) continue
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'the erasure of due data requests could not enter a store'
        )
      }
    }
    this.logger.info(report, 'the sweep of due data erasures finished')
    return report
  }

  private async sweepStore(
    storeId: string,
    now: Date,
    until: number,
    report: DsrEraseReport
  ): Promise<void> {
    const exhausted = await this.jobContext.forStore(storeId, () =>
      this.returnExhausted(storeId, now)
    )
    // Each was audited in the transaction that gave it back
    report.returned += exhausted.length
    // The closing notices that a queue that was down left unsent: the erasure is committed, the person still has to be told
    const unsent = await this.jobContext.forStore(storeId, () => this.unsentNoticesOf(storeId))
    for (const requestId of unsent) await this.notify(storeId, requestId, report)
    const candidates = await this.jobContext.forStore(storeId, () =>
      this.candidatesOf(storeId, now)
    )
    for (const requestId of candidates) {
      if (Date.now() > until) return
      await this.takeOne(storeId, requestId, now, report)
    }
  }

  private async takeOne(
    storeId: string,
    requestId: string,
    now: Date,
    report: DsrEraseReport
  ): Promise<void> {
    // The claim commits before the work starts: the try is counted even if the process dies in the middle of it
    const claimed = await this.jobContext.forStore(storeId, () =>
      this.claim(storeId, requestId, now)
    )
    if (!claimed) {
      report.skipped += 1
      return
    }
    try {
      const attempt = await this.jobContext.forStore(
        storeId,
        () => this.execute(storeId, requestId, now),
        { timeout: ComplianceConfig.DSR_ERASE_TRANSACTION_TIMEOUT_MS }
      )
      if (attempt.kind === 'skipped') {
        // Nothing was tried (a lock held by a reviewer, a state that moved): the try the claim counted is given back
        report.skipped += 1
        await this.jobContext.forStore(storeId, () => this.releaseClaim(storeId, requestId))
      } else if (attempt.kind === 'completed') {
        report.completed += 1
        // Audited inside the transaction that ended the request (a death between the commit and a later line cannot lose the entry)
        // After the commit: the person is told only of an erasure that happened
        await this.notify(storeId, requestId, report)
      } else {
        // Audited inside the transaction that gave the request back
        report.returned += 1
      }
    } catch (error) {
      report.failed += 1
      // The name only: the message of an error can hold a fragment of the data
      const code = errorName(error)
      this.logger.error(
        { storeId, requestId, errorName: code },
        'the erasure of a data request failed; it is tried again'
      )
      await this.recordFailure(storeId, requestId, code, report)
    }
  }

  // An approved erasure that used all its tries without ending (the last one killed the process, so no one recorded the failure): it goes back to
  // the review queue, the same way a request that failed its last try does
  private returnExhausted(
    storeId: string,
    now: Date
  ): Promise<{ id: string; organizationId: string }[]> {
    return this.prisma.transaction(async tx => {
      const rows = await tx.dataSubjectRequest.findMany({
        where: {
          storeId,
          type: DsrType.ERASURE,
          status: DsrStatus.IN_PROGRESS,
          erasureDueAt: { lte: now },
          erasureAttempts: { gte: ComplianceConfig.DSR_ERASE_MAX_ATTEMPTS },
          OR: [{ erasureAttemptedAt: null }, { erasureAttemptedAt: { lt: this.leaseEnd() } }]
        },
        orderBy: { erasureDueAt: 'asc' },
        take: ComplianceConfig.DSR_ERASE_BATCH,
        select: { id: true, organizationId: true }
      })
      const given: { id: string; organizationId: string }[] = []
      for (const row of rows) {
        const done = await tx.dataSubjectRequest.updateMany({
          where: { id: row.id, storeId, status: DsrStatus.IN_PROGRESS },
          data: this.backToReview(DsrErasureReturnReasons.ATTEMPTS_EXHAUSTED)
        })
        if (done.count === 1) {
          given.push(row)
          this.logReturned(
            storeId,
            row.organizationId,
            row.id,
            DsrErasureReturnReasons.ATTEMPTS_EXHAUSTED
          )
        }
      }
      return given
    })
  }

  private candidatesOf(storeId: string, now: Date): Promise<string[]> {
    return this.prisma
      .transaction(tx =>
        tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            type: DsrType.ERASURE,
            status: DsrStatus.IN_PROGRESS,
            erasureDueAt: { lte: now },
            erasureAttempts: { lt: ComplianceConfig.DSR_ERASE_MAX_ATTEMPTS },
            OR: [{ erasureAttemptedAt: null }, { erasureAttemptedAt: { lt: this.leaseEnd() } }]
          },
          orderBy: [{ erasureDueAt: 'asc' }, { id: 'asc' }],
          take: ComplianceConfig.DSR_ERASE_BATCH,
          select: { id: true }
        })
      )
      .then(rows => rows.map(row => row.id))
  }

  // The claim and the count of the try are ONE conditional UPDATE: the state, the date, the tries left and the lease are in its WHERE. A cancel
  // that won (state, or a date that moved) or a sweep that took it first leaves nothing to update.
  private claim(storeId: string, requestId: string, now: Date): Promise<boolean> {
    return this.prisma.transaction(async tx => {
      const done = await tx.dataSubjectRequest.updateMany({
        where: {
          id: requestId,
          storeId,
          type: DsrType.ERASURE,
          status: DsrStatus.IN_PROGRESS,
          erasureDueAt: { lte: now },
          erasureAttempts: { lt: ComplianceConfig.DSR_ERASE_MAX_ATTEMPTS },
          OR: [{ erasureAttemptedAt: null }, { erasureAttemptedAt: { lt: this.leaseEnd() } }]
        },
        data: { erasureAttempts: { increment: 1 }, erasureAttemptedAt: new Date() }
      })
      return done.count === 1
    })
  }

  private execute(storeId: string, requestId: string, now: Date): Promise<Attempt> {
    return this.prisma.transaction(async tx => {
      // The row is locked and looked at again: a cancel, a reviewer or another run may have changed it since the claim. A lock that is held
      // (a cancel in the middle of its own transaction) means this request is not ours tonight.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM data_subject_requests
        WHERE id = ${requestId} AND store_id = ${storeId} AND type = ${DsrType.ERASURE}
          AND status = ${DsrStatus.IN_PROGRESS} AND erasure_due_at <= ${now}
        FOR UPDATE SKIP LOCKED`
      if (locked.length === 0) return { kind: 'skipped' }
      const row = await tx.dataSubjectRequest.findFirstOrThrow({
        where: { id: requestId, storeId },
        select: {
          organizationId: true,
          subjectCustomerIds: true,
          subjectEmailHash: true
        }
      })

      const subject = await checkDsrSubject(
        tx,
        storeId,
        row.subjectCustomerIds,
        row.subjectEmailHash,
        this.config.hashKey
      )
      if (!subject.same) {
        await this.giveBack(
          tx,
          storeId,
          row.organizationId,
          requestId,
          DsrErasureReturnReasons.SUBJECT_CHANGED
        )
        return {
          kind: 'returned',
          organizationId: row.organizationId,
          reason: DsrErasureReturnReasons.SUBJECT_CHANGED,
          openWork: null
        }
      }
      // A merge into one of them that can still be undone brings the absorbed customer back whole: `erase` refuses, and trying would only spend
      // the tries of the request. The reviewer decides (wait for the window, or undo the merge)
      if (subject.pending.length > 0) {
        const undoable = await tx.customerMerge.count({
          where: {
            storeId,
            survivorId: { in: subject.pending },
            unmergedAt: null,
            unmergeUntil: { gt: new Date() }
          }
        })
        if (undoable > 0) {
          await this.giveBack(
            tx,
            storeId,
            row.organizationId,
            requestId,
            DsrErasureReturnReasons.UNDOABLE_MERGE
          )
          return {
            kind: 'returned',
            organizationId: row.organizationId,
            reason: DsrErasureReturnReasons.UNDOABLE_MERGE,
            openWork: null
          }
        }
      }
      // Work that opened after the approval (an order, a guide, a return) stops the erasure of the ones still to erase, before anything is touched
      if (subject.pending.length > 0) {
        const counts = await this.openWork.countOf(tx, storeId, subject.pending)
        if (hasOpenWork(counts)) {
          await this.giveBack(
            tx,
            storeId,
            row.organizationId,
            requestId,
            DsrErasureReturnReasons.BLOCKED_BY_OPEN_WORK,
            counts
          )
          return {
            kind: 'returned',
            organizationId: row.organizationId,
            reason: DsrErasureReturnReasons.BLOCKED_BY_OPEN_WORK,
            openWork: counts
          }
        }
      }

      const actor: Actor = {
        userId: SYSTEM_ACTOR_LABEL,
        storeId,
        system: true,
        dsrRequestId: requestId
      }
      for (const customerId of subject.pending) {
        await this.erasure.erase(storeId, customerId, actor)
      }

      const ids = row.subjectCustomerIds
      const [orders, conversations] = await Promise.all([
        tx.order.count({ where: { storeId, customerId: { in: ids } } }),
        tx.conversation.count({ where: { storeId, customerId: { in: ids } } })
      ])
      const retained = { orders, conversations }
      // The sealed address STAYS until the closing mail is queued (`notify`, after this commit): a queue that is down leaves the request ended
      // with its address, and the next night sends the mail. The mail is never queued before the erasure is committed, so it cannot announce
      // an erasure that rolled back.
      const done = await tx.dataSubjectRequest.updateMany({
        where: { id: requestId, storeId, status: DsrStatus.IN_PROGRESS },
        data: {
          status: DsrStatus.COMPLETED,
          completedAt: new Date(),
          retainedRecordsSummary: { legalBasis: LegalBases.LEGAL_OBLIGATION, ...retained },
          erasureFailureCode: null,
          subjectEmailHash: null
        }
      })
      // The row is locked and was in progress a moment ago: anything else is a bug, and rolling back undoes the erasures
      if (done.count !== 1) throw new Error('the data request changed under its lock')
      this.audit.log({
        action: AuditAction.DSR_ERASURE_COMPLETED,
        actor: { system: true },
        storeId,
        organizationId: row.organizationId,
        resourceType: DsrResourceTypes.REQUEST,
        resourceId: requestId,
        // Ids and counts only, never a name or an address
        metadata: {
          type: DsrType.ERASURE,
          customers: ids.length,
          retained,
          legalBasis: LegalBases.LEGAL_OBLIGATION
        }
      })
      return {
        kind: 'completed',
        organizationId: row.organizationId,
        customers: ids.length,
        retained
      }
    })
  }

  // A failed try is written in its own transaction (the one that failed rolled back). The request goes back to the review queue when it used
  // its last try; before that it waits for the next night.
  private async recordFailure(
    storeId: string,
    requestId: string,
    code: string,
    report: DsrEraseReport
  ): Promise<void> {
    try {
      const returned = await this.jobContext.forStore(storeId, () =>
        this.prisma.transaction(async tx => {
          await tx.dataSubjectRequest.updateMany({
            where: { id: requestId, storeId, status: DsrStatus.IN_PROGRESS },
            data: { erasureFailureCode: code }
          })
          const done = await tx.dataSubjectRequest.updateMany({
            where: {
              id: requestId,
              storeId,
              status: DsrStatus.IN_PROGRESS,
              erasureAttempts: { gte: ComplianceConfig.DSR_ERASE_MAX_ATTEMPTS }
            },
            data: this.backToReview(code)
          })
          if (done.count !== 1) return false
          const row = await tx.dataSubjectRequest.findFirstOrThrow({
            where: { id: requestId, storeId },
            select: { organizationId: true }
          })
          // Audited with the move, in this transaction
          this.logReturned(
            storeId,
            row.organizationId,
            requestId,
            DsrErasureReturnReasons.ATTEMPTS_EXHAUSTED
          )
          return true
        })
      )
      if (returned) report.returned += 1
    } catch (error) {
      this.logger.error(
        { storeId, requestId, errorName: errorName(error) },
        'the failure of an erasure could not be recorded'
      )
    }
  }

  // Gives the request back and audits it in the same transaction: the entry exists if and only if the request went back
  private async giveBack(
    tx: PrismaTransaction,
    storeId: string,
    organizationId: string,
    requestId: string,
    reason: DsrErasureReturnReason,
    openWork: DsrOpenWork | null = null
  ): Promise<void> {
    const done = await tx.dataSubjectRequest.updateMany({
      where: { id: requestId, storeId, status: DsrStatus.IN_PROGRESS },
      // Nothing was tried (the request itself is not ready: another person, open work, a merge): the try the claim counted is not spent, so the
      // next approval starts clean
      data: { ...this.backToReview(reason), erasureAttempts: 0, erasureAttemptedAt: null }
    })
    if (done.count === 1) this.logReturned(storeId, organizationId, requestId, reason, openWork)
  }

  // Back to the queue of the reviewers: the grace period and the approvals are cleared, so a new approval starts the cycle again (an approver
  // already in the list could not approve twice); the code says why
  private backToReview(code: string) {
    return {
      status: DsrStatus.MANUAL_REVIEW,
      erasureDueAt: null,
      approvals: [],
      erasureFailureCode: code
    }
  }

  // The lease runs from the clock of the moment it is read, not from the start of the run (a run lasts up to half an hour)
  private leaseEnd(): Date {
    return new Date(Date.now() - ComplianceConfig.DSR_ERASE_LEASE_MS)
  }

  private logReturned(
    storeId: string,
    organizationId: string,
    requestId: string,
    reason: string,
    openWork: DsrOpenWork | null = null
  ): void {
    this.audit.log({
      action: AuditAction.DSR_ERASURE_RETURNED,
      actor: { system: true },
      storeId,
      organizationId,
      resourceType: DsrResourceTypes.REQUEST,
      resourceId: requestId,
      // A reason and counts: no customer, no address
      metadata: { type: DsrType.ERASURE, reason, ...(openWork === null ? {} : { openWork }) }
    })
  }

  // Ended erasures that still hold their sealed address: the mail was not queued yet
  private unsentNoticesOf(storeId: string): Promise<string[]> {
    return this.prisma
      .transaction(tx =>
        tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            type: DsrType.ERASURE,
            status: DsrStatus.COMPLETED,
            notifyToEncrypted: { not: null }
          },
          orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
          take: ComplianceConfig.DSR_ERASE_BATCH,
          select: { id: true }
        })
      )
      .then(rows => rows.map(row => row.id))
  }

  // The try a claim counted, given back when nothing was tried
  private releaseClaim(storeId: string, requestId: string): Promise<unknown> {
    return this.prisma.transaction(tx =>
      tx.dataSubjectRequest.updateMany({
        where: {
          id: requestId,
          storeId,
          status: DsrStatus.IN_PROGRESS,
          erasureAttempts: { gt: 0 }
        },
        data: { erasureAttempts: { decrement: 1 }, erasureAttemptedAt: null }
      })
    )
  }

  // One closing mail, in its own transaction, after the erasure committed: the address is opened, the mail queued and the address cleared, in
  // that order, so a queue that is down changes nothing and the next night tries again. A failure here never undoes an erasure.
  private async notify(storeId: string, requestId: string, report: DsrEraseReport): Promise<void> {
    try {
      const sent = await this.jobContext.forStore(storeId, () =>
        this.prisma.transaction(async tx => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM data_subject_requests
            WHERE id = ${requestId} AND store_id = ${storeId} AND type = ${DsrType.ERASURE}
              AND status = ${DsrStatus.COMPLETED} AND notify_to_encrypted IS NOT NULL
            FOR UPDATE SKIP LOCKED`
          if (locked.length === 0) return false
          const row = await tx.dataSubjectRequest.findFirstOrThrow({
            where: { id: requestId, storeId },
            select: { notifyToEncrypted: true, retainedRecordsSummary: true }
          })
          const sealed = row.notifyToEncrypted
          const to =
            sealed === null ? null : openDsrNotifyAddress(sealed, this.config.encryptionKeyHex)
          // An address that does not open (a key that changed) cannot be mailed, and must not stay for ever
          if (to === null) {
            this.logger.error({ requestId }, 'the address of a data request could not be opened')
          } else {
            await this.queueMail(
              tx,
              storeId,
              requestId,
              to,
              retainedOrdersOf(row.retainedRecordsSummary)
            )
          }
          await tx.dataSubjectRequest.updateMany({
            where: { id: requestId, storeId, status: DsrStatus.COMPLETED },
            data: { notifyToEncrypted: null }
          })
          return to !== null
        })
      )
      if (sent) report.notified += 1
    } catch (error) {
      report.failed += 1
      this.logger.error(
        { storeId, requestId, errorName: errorName(error) },
        'the closing mail of an erased data request could not be queued; the next run tries again'
      )
    }
  }

  private async queueMail(
    tx: PrismaTransaction,
    storeId: string,
    requestId: string,
    to: string,
    retainedOrders: number
  ): Promise<void> {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { defaultLocale: true }
    })
    const locale: Locale =
      SUPPORTED_LOCALES.find(candidate => candidate === store?.defaultLocale) ?? DEFAULT_LOCALE
    await this.emailQueue.add(
      JobNames.SEND_EMAIL,
      {
        template: EmailTemplates.DSR_RESULT,
        to,
        locale,
        data: {
          outcome: DsrResultOutcomes.COMPLETED,
          requestType: DsrType.ERASURE,
          retainedOrders
        },
        tags: { template: EmailTemplates.DSR_RESULT }
      },
      // The job holds the address: gone as soon as it is sent or fails
      {
        jobId: dsrResultMailJobId(requestId),
        removeOnComplete: true,
        // The job holds the address in the clear, so it is dropped when it fails too. The sealed address on the request is cleared in the same
        // transaction that queues this job: a mail that fails ALL its attempts in the mail queue is not queued again (debt (o) of the plan)
        removeOnFail: true
      }
    )
  }
}

// What the summary of a finished request says it kept (the number the closing mail states)
function retainedOrdersOf(summary: unknown): number {
  const parsed = z.object({ orders: z.number().int().nonnegative() }).safeParse(summary)
  return parsed.success ? parsed.data.orders : 0
}
