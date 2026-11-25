import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  dsrNoticeJob,
  type DsrNoticeJob,
  dsrNoticeLocaleOf,
  DsrFailureCodes,
  DsrResultOutcomes,
  openDsrNotifyAddress
} from '@platform/core/compliance'
import { JobContext, PrismaService, type PrismaTransaction } from '@platform/core/database'
import { DsrStatus, DsrType } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import type { Locale } from '@platform/core/i18n'
import { DIGEST_LINKS, type DigestLinks } from '@platform/core/notifications'
import { QueueNames, type SendEmailJob } from '@platform/core/queues'

import { dsrExportLinkOf } from './dsr-export-link'
import { DsrNoticeLedger } from './dsr-notice-ledger.service'

// rls-context: every read and write of a request runs inside JobContext.forStore

// The kinds of request that end `completed` by a sweep of the worker and owe the person a closing notice
const COMPLETED_BY_SWEEP: readonly string[] = [DsrType.ERASURE, DsrType.ACCESS, DsrType.PORTABILITY]

// The closing notice of a request the worker finished (an erasure, an export), queued AFTER the work committed so a notice never announces
// what rolled back. The sealed address stays on the request until the mail processor confirms the send (`DsrNoticeLedger.sent`): a queue that
// is down, a mail that failed all its attempts and a confirmation that was lost all leave the address, and the next night asks for the mail
// once more, up to `DSR_NOTICE_MAX_ATTEMPTS` failures (Step 7.2-H2b-2, debts (l) and (o) of H2b-1).
@Injectable()
export class DsrNoticeSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly notices: DsrNoticeLedger,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig,
    @Inject(DIGEST_LINKS) private readonly links: DigestLinks,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrNoticeSender.name)
  }

  // How long a queued notice is left alone: the mail processor confirms or fails it well within this
  private leaseEnd(): Date {
    return new Date(Date.now() - ComplianceConfig.DSR_NOTICE_LEASE_MS)
  }

  // Ended requests whose notice the mail processor has not confirmed
  async pendingOf(storeId: string): Promise<string[]> {
    const rows = await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(tx =>
        tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            type: { in: [...COMPLETED_BY_SWEEP] },
            status: DsrStatus.COMPLETED,
            notifyToEncrypted: { not: null },
            noticeSentAt: null,
            noticeAttempts: { lt: ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS },
            OR: [{ noticeQueuedAt: null }, { noticeQueuedAt: { lt: this.leaseEnd() } }]
          },
          orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
          take: ComplianceConfig.DSR_ERASE_BATCH,
          select: { id: true }
        })
      )
    )
    return rows.map(row => row.id)
  }

  // A notice queued longer ago than `DSR_NOTICE_STALE_HOURS` that nobody confirmed or failed, and that has no tries left to queue again (its
  // address is gone, as after a rejection, or its count reached the limit)
  async giveUpStale(storeId: string): Promise<number> {
    const staleEnd = new Date(Date.now() - ComplianceConfig.DSR_NOTICE_STALE_HOURS * 3_600_000)
    const rows = await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(tx =>
        tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            noticeSentAt: null,
            noticeQueuedAt: { lt: staleEnd },
            OR: [
              { notifyToEncrypted: null },
              { noticeAttempts: { gte: ComplianceConfig.DSR_NOTICE_MAX_ATTEMPTS } }
            ]
          },
          orderBy: [{ noticeQueuedAt: 'asc' }, { id: 'asc' }],
          take: ComplianceConfig.DSR_ERASE_BATCH,
          select: { id: true }
        })
      )
    )
    for (const row of rows) await this.notices.giveUp(storeId, row.id, DsrFailureCodes.MAIL_LOST)
    return rows.length
  }

  // Queues the notices of a store that are still owed; returns how many were queued. Never throws: one that cannot be queued waits for tomorrow
  async sendPending(storeId: string): Promise<{ queued: number; failed: number }> {
    const result = { queued: 0, failed: 0 }
    // First the notices that will never be confirmed: they are given up, so they are not queued once more
    await this.giveUpStale(storeId).catch((error: unknown) => {
      result.failed += 1
      this.logger.error(
        { storeId, errorName: errorName(error) },
        'the stale closing notices of a store could not be given up'
      )
    })
    for (const requestId of await this.pendingOf(storeId)) {
      const done = await this.send(storeId, requestId)
      if (done === 'queued') result.queued += 1
      if (done === 'failed') result.failed += 1
    }
    return result
  }

  // One closing mail, in its own transaction: the address is opened and the mail queued. A failure here never undoes the work it announces.
  async send(storeId: string, requestId: string): Promise<'queued' | 'nothing' | 'failed'> {
    try {
      const outcome = await this.jobContext.forStore(storeId, () =>
        this.prisma.transaction(async tx => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM data_subject_requests
            WHERE id = ${requestId} AND store_id = ${storeId} AND status = ${DsrStatus.COMPLETED}
              AND type = ANY(${[...COMPLETED_BY_SWEEP]}::text[])
              AND notify_to_encrypted IS NOT NULL AND notice_sent_at IS NULL
              AND (notice_queued_at IS NULL OR notice_queued_at < ${this.leaseEnd()})
            FOR UPDATE SKIP LOCKED`
          if (locked.length === 0) return 'nothing' as const
          const row = await tx.dataSubjectRequest.findFirstOrThrow({
            where: { id: requestId, storeId },
            select: {
              type: true,
              notifyToEncrypted: true,
              noticeLocale: true,
              retainedRecordsSummary: true,
              resultKey: true,
              resultExpiresAt: true
            }
          })
          const sealed = row.notifyToEncrypted
          const to =
            sealed === null
              ? null
              : openDsrNotifyAddress(
                  sealed,
                  this.config.encryptionKeyHex,
                  this.config.previousEncryptionKeyHex
                )
          if (to === null) return 'unreadable' as const
          const job = await this.buildMail(
            tx,
            storeId,
            requestId,
            row.type,
            to,
            row.retainedRecordsSummary,
            row.noticeLocale,
            row.resultKey !== null ? row.resultExpiresAt : null
          )
          // The lease: a run that overlaps this one (or the next pass of the same one) sees a notice that is on its way and leaves it alone
          await tx.dataSubjectRequest.updateMany({
            where: { id: requestId, storeId },
            // The tries are counted when the notice is queued, in the same write: a job that never reaches the processor is counted too
            data: { noticeQueuedAt: new Date(), noticeAttempts: { increment: 1 } }
          })
          // Queued last: a write that failed above rolls the token back before any mail is queued. A failure of the COMMIT itself, after the add, can still leave a mail whose token is not stored (owner 7.7, debt in the plan)
          await this.emailQueue.add(job.name, job.data, job.opts)
          return 'queued' as const
        })
      )
      if (outcome === 'unreadable') {
        // An address that does not open (a key that changed) can never be mailed: the person is given up on, visibly, not silently
        this.logger.error({ requestId }, 'the address of a data request could not be opened')
        await this.notices.unreadable(storeId, requestId)
        return 'failed'
      }
      return outcome
    } catch (error) {
      this.logger.error(
        { storeId, requestId, errorName: errorName(error) },
        'the closing mail of a data request could not be queued; the next run tries again'
      )
      return 'failed'
    }
  }

  private async buildMail(
    tx: PrismaTransaction,
    storeId: string,
    requestId: string,
    requestType: string,
    to: string,
    summary: unknown,
    requestLocale: string | null,
    fileExpiresAt: Date | null
  ): Promise<DsrNoticeJob> {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { defaultLocale: true }
    })
    const locale: Locale = dsrNoticeLocaleOf(requestLocale, store?.defaultLocale)
    const job = dsrNoticeJob({
      requestId,
      storeId,
      to,
      locale,
      outcome: DsrResultOutcomes.COMPLETED,
      requestType,
      ...(requestType === String(DsrType.ERASURE)
        ? { retainedOrders: retainedOrdersOf(summary) }
        : {}),
      // An export that still holds its file brings the link that hands it over; one whose file is gone brings none (the mail then says so)
      ...(await dsrExportLinkOf(tx, {
        requestId,
        requestType,
        fileExpiresAt,
        frontendUrl: this.links.frontendUrl
      }))
    })
    return job
  }
}

// What the summary of a finished request says it kept (the number the closing mail states)
function retainedOrdersOf(summary: unknown): number {
  const parsed = z.object({ orders: z.number().int().nonnegative() }).safeParse(summary)
  return parsed.success ? parsed.data.orders : 0
}
