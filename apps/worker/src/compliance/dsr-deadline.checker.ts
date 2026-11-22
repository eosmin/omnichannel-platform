import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig, DsrResourceTypes } from '@platform/core/compliance'
import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import { DAY_MS, DsrStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { allStoreIds } from '../schedulers/store-sweep'

// rls-context: the stores are listed from `stores`; every read and write of a request runs inside JobContext.forStore

// Requests still open (in review, or approved and waiting for the sweep that carries them out): one that was not answered by the day the law
// leaves a few days for is the one that needs a person
const OPEN: readonly string[] = [DsrStatus.MANUAL_REVIEW, DsrStatus.IN_PROGRESS]

export interface DsrDeadlineReport {
  alerted: number
  failed: number
}

// The alert of day 25 (TDD_05 §10.2, Step 7.2-H2b-2): a request that is still open when the days left of its legal deadline
// (`DSR_RESPONSE_DEADLINE_DAYS` less `DSR_DEADLINE_ALERT_DAY`) are used up tells the reviewers, ONCE (a conditional UPDATE of
// `deadline_alert_sent_at` is the claim: two runs, or a run and a retry, raise one event). The 60-day extension is not in the MVP: with the grace
// period of 7 days the usual request fits the deadline, and this alert is how a slow review is caught.
@Injectable()
export class DsrDeadlineChecker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrDeadlineChecker.name)
  }

  async run(now: Date = new Date()): Promise<DsrDeadlineReport> {
    const report: DsrDeadlineReport = { alerted: 0, failed: 0 }
    for (const storeId of await allStoreIds(this.prisma)) {
      try {
        report.alerted += await this.checkStore(storeId, now)
      } catch (error) {
        if (error instanceof JobContextGoneError) continue
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'the deadlines of the data requests of a store could not be checked'
        )
      }
    }
    if (report.alerted > 0 || report.failed > 0) {
      this.logger.info(report, 'the check of data request deadlines finished')
    }
    return report
  }

  private async checkStore(storeId: string, now: Date): Promise<number> {
    const warnFrom = new Date(
      now.getTime() +
        (ComplianceConfig.DSR_RESPONSE_DEADLINE_DAYS - ComplianceConfig.DSR_DEADLINE_ALERT_DAY) *
          DAY_MS
    )
    const due = await this.jobContext.forStore(storeId, () =>
      this.prisma.transaction(tx =>
        tx.dataSubjectRequest.findMany({
          where: {
            storeId,
            status: { in: [...OPEN] },
            deadlineAlertSentAt: null,
            deadlineAt: { lte: warnFrom }
          },
          orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
          take: ComplianceConfig.DSR_EXPIRE_BATCH,
          select: { id: true }
        })
      )
    )
    let alerted = 0
    for (const { id } of due) {
      try {
        const done = await this.jobContext.forStore(storeId, () =>
          this.prisma.transaction(async tx => {
            // The claim: the first run to set the mark raises the alert; the state is in the same WHERE, so a request that was answered meanwhile is not
            const claimed = await tx.dataSubjectRequest.updateMany({
              where: {
                id,
                storeId,
                status: { in: [...OPEN] },
                deadlineAlertSentAt: null,
                deadlineAt: { lte: warnFrom }
              },
              data: { deadlineAlertSentAt: now }
            })
            if (claimed.count !== 1) return false
            const row = await tx.dataSubjectRequest.findFirstOrThrow({
              where: { id, storeId },
              select: { organizationId: true, type: true, deadlineAt: true }
            })
            const daysLeft = Math.max(
              0,
              Math.ceil((row.deadlineAt.getTime() - now.getTime()) / DAY_MS)
            )
            this.audit.log({
              action: AuditAction.DSR_DEADLINE_ALERTED,
              actor: { system: true },
              storeId,
              organizationId: row.organizationId,
              resourceType: DsrResourceTypes.REQUEST,
              resourceId: id,
              metadata: { type: row.type, daysLeft }
            })
            this.events.publish(tx, Events.DSR_DEADLINE_APPROACHING, {
              storeId,
              requestId: id,
              type: row.type,
              daysLeft
            })
            return true
          })
        )
        if (done) alerted += 1
      } catch (error) {
        this.logger.error(
          { storeId, requestId: id, errorName: errorName(error) },
          'the deadline alert of a data request failed; the next run tries again'
        )
      }
    }
    return alerted
  }
}
