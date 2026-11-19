// rls-context: every database access of this file runs inside `unit` (JobContext.inOrganization); the queue is reached outside of it
import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Gauge } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { inSavepoint, isUniqueViolation, JobContext, PrismaService } from '@platform/core/database'
import {
  FiscalIssueOn,
  FiscalLimits,
  FiscalSweepKind,
  fiscalJobOptions,
  FiscalSweepLimits
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  JobNames,
  QueueNames,
  submitFiscalDocumentJobId,
  type SubmitFiscalDocumentJob
} from '@platform/core/queues'
import {
  type FiscalFinding,
  FiscalContingencyService,
  FiscalDocumentsService,
  FiscalSweepService
} from '@platform/fiscal/runtime'

export interface FiscalReconcileReport {
  // What each kind found (up to the cap of one run)
  found: Record<FiscalSweepKind, number>
  // Documents made by this run and sent to the queue
  queued: number
  // A finding the lifecycle declined to act on (a sale that cannot be documented, a return with nothing to cancel): a person looks at it
  unresolved: number
  truncated: boolean
}

// The daily check of the fiscal documents of one organization (TDD_18 §8.3, §11). It finds what the lifecycle lost and ASKS for it: a sale
// with no document gets its document through the lifecycle service and its job, a document left in the queue gets its job again, a return
// with no credit note gets it. It never submits a document itself: the job does, with the provider the issuer names (the simulator is the
// only one that exists), under the idempotency key of the submission, so a document found twice is one submission. A document that
// disagrees with its entry is counted, logged and told to a person, and nothing is corrected. One finding that cannot be acted on is
// logged and the rest goes on.
@Injectable()
export class FiscalReconciler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sweep: FiscalSweepService,
    private readonly documents: FiscalDocumentsService,
    private readonly contingencies: FiscalContingencyService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly queue: Queue<SubmitFiscalDocumentJob>,
    @InjectMetric(MetricNames.FINANCE_FISCAL_FINDINGS) private readonly findings: Gauge<string>,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(FiscalReconciler.name)
  }

  // Each read or write of the run is one short unit in a context of the organization: a finding that fails aborts only its own unit (a
  // transaction that failed once refuses every later statement), and the queue is reached between two units, never inside one
  private unit<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.jobContext.inOrganization(organizationId, work, {
      maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
      timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
    })
  }

  async reconcile(organizationId: string, now: Date = new Date()): Promise<FiscalReconcileReport> {
    const issuer = await this.unit(organizationId, () =>
      this.prisma.client.fiscalIssuer.findUnique({
        where: { organizationId },
        select: { issueOn: true }
      })
    )
    const found = emptyCounts()
    const report: FiscalReconcileReport = { found, queued: 0, unresolved: 0, truncated: false }
    // An organization that issues no documents has nothing to find: its gauges are zero
    if (issuer === null) {
      this.publish(organizationId, found)
      // The contingencies do not depend on the issuer row (it may be gone): their report and their window are still checked
      const stuck = await this.checkContingencies(organizationId, now)
      if (stuck.length > 0) {
        throw new Error(`${stuck.length} contingency checks failed`, { cause: stuck[0] })
      }
      return report
    }
    // What is left after the run, for the gauge: a sale or a credit note the lifecycle made is no longer missing, a document asked for again
    // is still left until it moves, and a disagreement stays until a person decides
    const remaining = emptyCounts()
    const failures: unknown[] = []
    for (const kind of Object.values(FiscalSweepKind)) {
      const mismatches: FiscalFinding[] = []
      let cursor: string | undefined
      let pages = 0
      for (;;) {
        const page = await this.sweep.find(organizationId, kind, {
          limit: FiscalSweepLimits.RUN_PAGE_SIZE,
          now,
          ...(cursor === undefined ? {} : { cursor })
        })
        pages += 1
        found[kind] += page.data.length
        if (kind === FiscalSweepKind.ENTRY_MISMATCH) {
          mismatches.push(...page.data)
          remaining[kind] += page.data.length
        }
        if (kind !== FiscalSweepKind.ENTRY_MISMATCH) {
          for (const item of page.data) {
            try {
              const result = await this.act(organizationId, item, issuer.issueOn as FiscalIssueOn)
              if (result === 'queued') report.queued += 1
              if (result === 'declined') report.unresolved += 1
              // Left after the run: what the lifecycle declined, and a document asked for again until it moves
              if (kind === FiscalSweepKind.STALLED_DOCUMENT || result === 'declined') {
                remaining[kind] += 1
              }
            } catch (error) {
              // The rest goes on; the job fails at the end so the queue asks again (every step is idempotent)
              failures.push(error)
              report.unresolved += 1
              remaining[kind] += 1
              this.logger.warn(
                { organizationId, kind, errorName: errorName(error) },
                'a fiscal finding could not be acted on'
              )
            }
          }
        }
        if (page.nextCursor === null) break
        cursor = page.nextCursor
        // The pages go on past a finding nobody can act on, so it cannot starve the ones behind it; a run reads at most this many
        if (pages >= FiscalSweepLimits.MAX_PAGES_PER_KIND) {
          report.truncated = true
          break
        }
      }
      if (kind === FiscalSweepKind.ENTRY_MISMATCH) {
        await this.tellMismatch(organizationId, mismatches)
      }
    }
    failures.push(...(await this.checkContingencies(organizationId, now)))
    this.publish(organizationId, remaining)
    if (report.truncated) {
      this.logger.warn({ organizationId }, 'the check of the fiscal documents stopped at its cap')
    }
    this.logger.info(
      { organizationId, found, queued: report.queued, unresolved: report.unresolved },
      'the fiscal documents were checked'
    )
    if (failures.length > 0) {
      // An error of the infrastructure (the queue, the database) must not pass for a finished night: the job is asked again
      throw new Error(`${failures.length} fiscal findings could not be acted on`, {
        cause: failures[0]
      })
    }
    return report
  }

  // Contingencies (Step 4B.7c-7): a report that is owed is asked again, and the person is told when a window is closing. Each step is
  // its own: one that cannot be queued does not leave the others, nor the warning, for another day. Returns what failed.
  private async checkContingencies(organizationId: string, now: Date): Promise<unknown[]> {
    const failures: unknown[] = []
    try {
      for (const id of await this.contingencies.unreported(organizationId)) {
        try {
          await this.contingencies.askReport(organizationId, id, now)
        } catch (error) {
          failures.push(error)
        }
      }
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.contingencies.warnWindows(organizationId, now)
    } catch (error) {
      failures.push(error)
    }
    return failures
  }

  private publish(organizationId: string, found: Record<FiscalSweepKind, number>): void {
    for (const kind of Object.values(FiscalSweepKind)) {
      this.findings.set({ organization_id: organizationId, kind }, found[kind])
    }
  }

  // `queued`: a job was asked for; `exists`: another path (the listener of the sale) made the document first, which is the answer;
  // `declined`: the lifecycle has nothing to make for it
  private async act(
    organizationId: string,
    item: FiscalFinding,
    issueOn: FiscalIssueOn
  ): Promise<'queued' | 'exists' | 'declined'> {
    if (item.kind === FiscalSweepKind.SALE_WITHOUT_DOCUMENT) {
      let documentId: string | null
      try {
        documentId = await inSavepoint(() =>
          this.documents.createForOrder(organizationId, item.orderId, issueOn)
        )
      } catch (error) {
        // The listener of the sale made it between the sweep's read and its insert: the unique index of the live sale document says so
        if (isUniqueViolation(error)) return 'exists'
        throw error
      }
      if (documentId === null) return 'declined'
      await this.enqueue(organizationId, documentId, 1)
      return 'queued'
    }
    if (item.kind === FiscalSweepKind.CREDIT_NOTE_MISSING) {
      const documentId = await this.documents.createCreditNoteForReturn(organizationId, item.id)
      if (documentId === null) return 'declined'
      await this.enqueue(organizationId, documentId, 1)
      return 'queued'
    }
    // A document left in the queue: the same job again (a job that still waits has the same id and is not added twice)
    await this.enqueue(organizationId, item.id, item.submission ?? 1)
    return 'queued'
  }

  // The same job, the same id and the same options as the producer of the api (`FiscalSubmissionQueue`): a request of a person and the
  // sweep of the night are one job for one submission
  private async enqueue(
    organizationId: string,
    documentId: string,
    submission: number
  ): Promise<void> {
    const jobId = submitFiscalDocumentJobId(documentId, submission)
    // A job that failed stays a week and would drop the new one with the same id: the failed one goes
    const earlier = await this.queue.getJob(jobId)
    if (earlier !== undefined && (await earlier.isFailed())) await earlier.remove()
    await this.queue.add(
      JobNames.SUBMIT_FISCAL_DOCUMENT,
      { organizationId, documentId },
      { ...fiscalJobOptions(), jobId }
    )
  }

  private async tellMismatch(
    organizationId: string,
    items: readonly FiscalFinding[]
  ): Promise<void> {
    const first = items[0]
    if (first === undefined) return
    // Never fixed from here: the document and the entry are both evidence, and which one is right is the accountant's
    this.logger.error(
      { organizationId, count: items.length },
      'sale documents disagree with their entries of the books'
    )
    // The notice is once for each person and document until it is read: asking every night does not repeat it
    await this.unit(organizationId, () =>
      this.prisma.transaction(tx => {
        this.events.publish(tx, Events.FISCAL_ENTRY_MISMATCH, {
          organizationId,
          documentId: first.id,
          count: items.length
        })
        return Promise.resolve()
      })
    )
  }
}

function emptyCounts(): Record<FiscalSweepKind, number> {
  return {
    [FiscalSweepKind.SALE_WITHOUT_DOCUMENT]: 0,
    [FiscalSweepKind.STALLED_DOCUMENT]: 0,
    [FiscalSweepKind.CREDIT_NOTE_MISSING]: 0,
    [FiscalSweepKind.ENTRY_MISMATCH]: 0
  }
}
