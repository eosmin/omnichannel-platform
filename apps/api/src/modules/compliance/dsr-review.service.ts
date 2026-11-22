import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  type DsrOpenWork,
  DsrRejectionReasons,
  type DsrResultOutcome,
  DsrResultOutcomes,
  openDsrNotifyAddress,
  DsrResourceTypes,
  dsrEmailHash,
  dsrExecutorAvailable,
  hasOpenWork,
  normalizeDsrEmail
} from '@platform/core/compliance'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import { DAY_MS, DsrStatus, DsrType } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { EmailTemplates, JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'

import { type Actor, auditActorOf } from '../tenancy'

import type { DsrApproveBody, DsrDecisionBody, ListDsrQuery } from './compliance.schemas'
import { DsrOpenWorkService } from './dsr-open-work.service'

// Tells whether something carries out an approved request. A provider so that a spec can answer true before the sweep exists (H2b).
export const DSR_EXECUTOR_PROBE = Symbol('DSR_EXECUTOR_PROBE')
export type DsrExecutorProbe = () => boolean
export const dsrExecutorProbe: DsrExecutorProbe = dsrExecutorAvailable

const approvalsSchema = z.array(z.object({ userId: z.string(), at: z.iso.datetime() }))

// A request as the review queue shows it. No address (it is never stored in the clear), no name: the customers are named by id, and the
// team reads them where it reads customers.
export interface DsrRequestView {
  id: string
  type: string
  status: string
  requestedAt: string
  deadlineAt: string
  verifiedAt: string | null
  reviewedAt: string | null
  reviewedBy: string | null
  requestedBy: string | null
  erasureDueAt: string | null
  completedAt: string | null
  rejectionReason: string | null
  subjectCustomerIds: string[]
  approvals: { userId: string; at: string }[]
  notes: string | null
}
export interface DsrRequestDetail extends DsrRequestView {
  // What an erasure would wait for, counted now. null for a kind that erases nothing and for a request that has ended
  openWork: DsrOpenWork | null
}
// The page of every list of the api (TDD_08 §2.4)
export interface DsrRequestPage {
  data: DsrRequestView[]
  nextCursor: string | null
  hasMore: boolean
}

const SELECT = {
  id: true,
  type: true,
  status: true,
  requestedAt: true,
  deadlineAt: true,
  verifiedAt: true,
  reviewedAt: true,
  reviewedBy: true,
  requestedBy: true,
  erasureDueAt: true,
  completedAt: true,
  rejectionReason: true,
  subjectCustomerIds: true,
  subjectEmailHash: true,
  notifyToEncrypted: true,
  approvals: true,
  notes: true
} as const

type Row = Awaited<ReturnType<typeof readRow>>

function readRow(tx: PrismaTransaction, storeId: string, id: string) {
  return tx.dataSubjectRequest.findFirstOrThrow({ where: { id, storeId }, select: SELECT })
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString())

function approvalsOf(value: unknown): { userId: string; at: string }[] {
  const parsed = approvalsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

function viewOf(row: Row): DsrRequestView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
    verifiedAt: iso(row.verifiedAt),
    reviewedAt: iso(row.reviewedAt),
    reviewedBy: row.reviewedBy,
    requestedBy: row.requestedBy,
    erasureDueAt: iso(row.erasureDueAt),
    completedAt: iso(row.completedAt),
    rejectionReason: row.rejectionReason,
    subjectCustomerIds: row.subjectCustomerIds,
    approvals: approvalsOf(row.approvals),
    notes: row.notes
  }
}

const ENDED: readonly string[] = [DsrStatus.COMPLETED, DsrStatus.REJECTED, DsrStatus.CANCELLED]

// A request that does not take the decision: one that ended answers "already completed" (terminal), any other that it is not in review
function notReviewable(status: string): PlatformException {
  const ended = ENDED.includes(status)
  return new PlatformException(
    ended ? ErrorCodes.DSR_ALREADY_COMPLETED : ErrorCodes.DSR_NOT_REVIEWABLE,
    ended ? 'the data request already ended' : 'the data request is not in a state that takes this',
    HttpStatusCodes.CONFLICT,
    { status }
  )
}

// The review queue of the data requests of a store (TDD_05 §10.2, Step 7.2-H1b). Every read and write is filtered by the store of the
// request (the one of the `TenantGuard`, never the body), so the id of a request of another store is a 404, whatever store it is. A
// decision locks the row of the request first: two reviewers, or a reviewer and the sweep, take turns.
@Injectable()
export class DsrReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly openWork: DsrOpenWorkService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig,
    @Inject(DSR_EXECUTOR_PROBE) private readonly executorAvailable: DsrExecutorProbe,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(DsrReviewService.name)
  }

  async list(storeId: string, query: ListDsrQuery): Promise<DsrRequestPage> {
    return this.prisma.transaction(async tx => {
      // A cursor is a request of THIS store: another store's id cannot be used to find a position in this list
      if (query.cursor !== undefined) {
        const anchor = await tx.dataSubjectRequest.findFirst({
          where: { id: query.cursor, storeId },
          select: { id: true }
        })
        if (anchor === null) return { data: [], nextCursor: null, hasMore: false }
      }
      const rows = await tx.dataSubjectRequest.findMany({
        where: {
          storeId,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.type === undefined ? {} : { type: query.type })
        },
        select: SELECT,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 })
      })
      const page = rows.slice(0, query.limit)
      const hasMore = rows.length > query.limit
      return {
        data: page.map(viewOf),
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
        hasMore
      }
    })
  }

  async get(storeId: string, id: string): Promise<DsrRequestDetail> {
    return this.prisma.transaction(async tx => {
      const row = await tx.dataSubjectRequest.findFirst({ where: { id, storeId }, select: SELECT })
      if (row === null) throw resourceNotFound('data request')
      const counts =
        row.type === String(DsrType.ERASURE) && !ENDED.includes(row.status)
          ? await this.openWork.countOf(tx, storeId, row.subjectCustomerIds)
          : null
      return { ...viewOf(row), openWork: counts }
    })
  }

  async approve(
    storeId: string,
    id: string,
    body: DsrApproveBody,
    actor: Actor
  ): Promise<DsrRequestView> {
    const { view, counts } = await this.prisma.transaction(async tx => {
      const row = await this.lock(tx, storeId, id)
      if (row.status !== String(DsrStatus.MANUAL_REVIEW)) throw notReviewable(row.status)
      // Nothing carries out an approved request yet (a sweep of H2b): approving one would promise what no one will do
      if (row.type !== String(DsrType.ERASURE) || !this.executorAvailable()) {
        throw new PlatformException(
          ErrorCodes.DSR_EXECUTOR_UNAVAILABLE,
          'nothing carries out an approved data request yet',
          HttpStatusCodes.CONFLICT
        )
      }
      // A request an admin made for the person is not approved by the same admin
      if (row.requestedBy !== null && row.requestedBy === actor.userId) {
        throw new PlatformException(
          ErrorCodes.PERMISSION_DENIED,
          'the approver is the person who made the request',
          HttpStatusCodes.FORBIDDEN
        )
      }
      const approvals = approvalsOf(row.approvals)
      if (approvals.some(approval => approval.userId === actor.userId)) {
        throw notReviewable(row.status)
      }

      await this.checkSubject(tx, storeId, row)
      const counts = await this.openWork.countOf(tx, storeId, row.subjectCustomerIds)
      if (hasOpenWork(counts)) {
        throw new PlatformException(
          ErrorCodes.DSR_BLOCKED_BY_OPEN_WORK,
          'the customer has open work, so the data cannot be erased yet',
          HttpStatusCodes.CONFLICT,
          { ...counts }
        )
      }

      const now = new Date()
      const next = [...approvals, { userId: actor.userId, at: now.toISOString() }]
      const complete = next.length >= ComplianceConfig.DSR_ERASURE_APPROVALS_REQUIRED
      await tx.dataSubjectRequest.updateMany({
        where: { id, storeId },
        data: {
          approvals: next,
          reviewedBy: actor.userId,
          reviewedAt: now,
          notes: body.reason,
          ...(complete
            ? {
                status: DsrStatus.IN_PROGRESS,
                erasureDueAt: new Date(
                  now.getTime() + ComplianceConfig.ERASURE_GRACE_PERIOD_DAYS * DAY_MS
                )
              }
            : {})
        }
      })
      return { view: viewOf(await readRow(tx, storeId, id)), counts }
    })

    this.audit.log({
      action: AuditAction.DSR_APPROVED,
      actor: auditActorOf(actor),
      storeId,
      resourceType: DsrResourceTypes.REQUEST,
      resourceId: id,
      // Ids and counts only: not the reason, not the customers' data
      metadata: {
        type: view.type,
        customers: view.subjectCustomerIds.length,
        approvals: view.approvals.length,
        erasureDueAt: view.erasureDueAt,
        openWork: counts
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return view
  }

  // The answer to the person is queued IN the transaction, before the sealed address is cleared: if it cannot be queued nothing changes,
  // and the reviewer tries again (the address is read from the row, never from the request)
  async reject(
    storeId: string,
    id: string,
    body: DsrDecisionBody,
    actor: Actor
  ): Promise<DsrRequestView> {
    const view = await this.prisma.transaction(async tx => {
      const row = await this.lock(tx, storeId, id)
      if (row.status !== String(DsrStatus.MANUAL_REVIEW)) throw notReviewable(row.status)
      const now = new Date()
      const done = await tx.dataSubjectRequest.updateMany({
        where: { id, storeId, status: DsrStatus.MANUAL_REVIEW },
        data: {
          status: DsrStatus.REJECTED,
          rejectionReason: DsrRejectionReasons.REVIEWER_DECISION,
          notes: body.reason,
          reviewedBy: actor.userId,
          reviewedAt: now,
          completedAt: now,
          notifyToEncrypted: null,
          subjectEmailHash: null
        }
      })
      if (done.count !== 1) throw notReviewable(row.status)
      await this.mailResult(tx, storeId, row, DsrResultOutcomes.REJECTED)
      return viewOf(await readRow(tx, storeId, id))
    })
    this.logEnd(AuditAction.DSR_REJECTED, storeId, view, actor)
    return view
  }

  // An approved erasure is pulled back while its grace period runs. The update is conditional (in progress AND the date still ahead), so the
  // sweep that executes an erasure at the date and this call cannot both win; the loser answers 409.
  async cancel(
    storeId: string,
    id: string,
    body: DsrDecisionBody,
    actor: Actor
  ): Promise<DsrRequestView> {
    const view = await this.prisma.transaction(async tx => {
      const row = await this.lock(tx, storeId, id)
      const now = new Date()
      const done = await tx.dataSubjectRequest.updateMany({
        where: { id, storeId, status: DsrStatus.IN_PROGRESS, erasureDueAt: { gt: now } },
        data: {
          status: DsrStatus.CANCELLED,
          notes: body.reason,
          reviewedBy: actor.userId,
          reviewedAt: now,
          completedAt: now,
          erasureDueAt: null,
          notifyToEncrypted: null,
          subjectEmailHash: null
        }
      })
      if (done.count !== 1) throw notReviewable(row.status)
      await this.mailResult(tx, storeId, row, DsrResultOutcomes.CANCELLED)
      return viewOf(await readRow(tx, storeId, id))
    })
    this.logEnd(AuditAction.DSR_CANCELLED, storeId, view, actor)
    return view
  }

  private logEnd(
    action: AuditActionType,
    storeId: string,
    view: DsrRequestView,
    actor: Actor
  ): void {
    this.audit.log({
      action,
      actor: auditActorOf(actor),
      storeId,
      resourceType: DsrResourceTypes.REQUEST,
      resourceId: view.id,
      metadata: { type: view.type },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  // The row of the request of THIS store, locked. Another store's id finds nothing: a 404 like an id that does not exist.
  private async lock(tx: PrismaTransaction, storeId: string, id: string): Promise<Row> {
    const found = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM data_subject_requests WHERE id = ${id} AND store_id = ${storeId} FOR UPDATE`
    if (found.length === 0) throw resourceNotFound('data request')
    return readRow(tx, storeId, id)
  }

  // The customers the request names still are the people that asked: not erased, not merged away, and each still has the address that made
  // the request (compared by its keyed hash). The rows are locked in id order, so a merge, an edit or an erasure of one of them waits.
  private async checkSubject(tx: PrismaTransaction, storeId: string, row: Row): Promise<void> {
    const ids = row.subjectCustomerIds
    const customers = await tx.$queryRaw<
      { id: string; email: string | null; erased_at: Date | null; merged_into_id: string | null }[]
    >`
      SELECT id, email, erased_at, merged_into_id FROM customers
      WHERE store_id = ${storeId} AND id = ANY(${ids}::text[])
      ORDER BY id FOR UPDATE`
    const same =
      ids.length > 0 &&
      customers.length === ids.length &&
      row.subjectEmailHash !== null &&
      customers.every(
        customer =>
          customer.erased_at === null &&
          customer.merged_into_id === null &&
          customer.email !== null &&
          dsrEmailHash(normalizeDsrEmail(customer.email), this.config.hashKey) ===
            row.subjectEmailHash
      )
    if (!same) {
      throw new PlatformException(
        ErrorCodes.DSR_SUBJECT_CHANGED,
        'the customer of the data request changed',
        HttpStatusCodes.CONFLICT
      )
    }
  }

  // The closing mail: the address is opened here, inside the transaction, and handed to the queue before the caller clears it
  private async mailResult(
    tx: PrismaTransaction,
    storeId: string,
    row: Row,
    outcome: DsrResultOutcome
  ): Promise<void> {
    if (row.notifyToEncrypted === null) return
    const to = openDsrNotifyAddress(row.notifyToEncrypted, this.config.encryptionKeyHex)
    // An address that does not open (a key that changed) cannot be mailed, and must not keep the request from being decided
    if (to === null) {
      this.logger.error({ requestId: row.id }, 'the address of a data request could not be opened')
      return
    }
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
        data: { outcome, requestType: row.type },
        tags: { template: EmailTemplates.DSR_RESULT }
      },
      // The job holds the address: gone as soon as it is sent, and an hour after a failure
      {
        removeOnComplete: true,
        removeOnFail: { age: ComplianceConfig.DSR_INTAKE_JOB_TTL_MS / 1000 }
      }
    )
  }
}
