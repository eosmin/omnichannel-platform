import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { isUniqueViolation, PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  OrderReturnCondition,
  OrderStatus,
  ReceptionBatchStatus,
  ReceptionItemOutcome,
  ReceptionLimits,
  ReceptionReasons,
  ReceptionScanResults,
  type ReceptionLine,
  receptionLinesSchema,
  ReturnResourceTypes,
  ShipmentKind,
  ShipmentStatus,
  type ScanCodeBody,
  type UpdateReceptionItemBody
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { ReturnsService, ScannableShipmentStatuses } from '@platform/core/shipping'
import { readStorePreferences } from '@platform/core/store-preferences'

import { CustomerCautionService } from '../customers/customer-caution.service'
import type { Actor } from '../tenancy'

import { flagReasonOf } from './return-reception.rules'
import {
  type ReceptionBatchSummaryView,
  type ReceptionBatchView,
  type ReceptionCandidateView,
  receptionCounts,
  type ReceptionItemRow,
  receptionItemSelect,
  type ReceptionItemView,
  receptionItemView,
  type ScanResultView
} from './return-reception.views'

// A batch accepts changes to its packages while it is a draft, and after a completion that left some failed (to fix and retry)
const EDITABLE: readonly string[] = [
  ReceptionBatchStatus.DRAFT,
  ReceptionBatchStatus.COMPLETED_WITH_ERRORS
]

function conflict(
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
  metadata?: Record<string, unknown>
) {
  return new PlatformException(code, message, HttpStatusCodes.CONFLICT, metadata)
}

function flagNeedsReason() {
  return new PlatformException(
    ErrorCodes.RECEPTION_FLAG_NEEDS_REASON,
    'a flagged customer needs a reason or a note',
    HttpStatusCodes.BAD_REQUEST
  )
}

function invalid(message: string) {
  return new PlatformException(
    ErrorCodes.VALIDATION_INVALID_INPUT,
    message,
    HttpStatusCodes.BAD_REQUEST
  )
}

interface BatchRow {
  status: string
  started: Date | null
}

const BatchLocks = { NONE: 'none', SHARED: 'shared', EXCLUSIVE: 'exclusive' } as const
type BatchLock = (typeof BatchLocks)[keyof typeof BatchLocks]

const candidateOf = (match: {
  id: string
  guideNumber: string | null
  status: string
  kind: string
  order: { orderNumber: string }
}): ReceptionCandidateView => ({
  shipmentId: match.id,
  guideNumber: match.guideNumber,
  orderNumber: match.order.orderNumber,
  status: match.status as ShipmentStatus,
  kind: match.kind as ShipmentKind
})

const mayFlag = (held: readonly Permission[]): boolean =>
  held.includes(Permissions.CUSTOMERS_FLAG_CAUTION)

// The reception of the packages that come back (TDD_17 §4.16): a batch the agent fills by scanning, saved as it goes, and
// completed in one go. Each package is received in its own transaction by `ReturnsService.receiveFromScan` (a package that fails
// does not undo the others), and then its customer is flagged when the agent asked for it. Nothing here moves stock, money or
// an order: that is the returns service, which the batch only calls.
@Injectable()
export class ReturnReceptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly returns: ReturnsService,
    private readonly caution: CustomerCautionService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ReturnReceptionService.name)
  }

  async createBatch(
    storeId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<ReceptionBatchView> {
    const batch = await this.prisma.client.returnReceptionBatch.create({
      data: { storeId, createdBy: actor.userId },
      select: { id: true }
    })
    return this.getBatch(storeId, batch.id, held)
  }

  async listBatches(
    storeId: string,
    status: ReceptionBatchStatus | undefined
  ): Promise<ReceptionBatchSummaryView[]> {
    const rows = await this.prisma.client.returnReceptionBatch.findMany({
      where: { storeId, ...(status === undefined ? {} : { status }) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ReceptionLimits.LIST_LIMIT,
      select: {
        id: true,
        status: true,
        createdBy: true,
        createdAt: true,
        completedAt: true,
        items: { select: { outcome: true } }
      }
    })
    return rows.map(row => ({
      id: row.id,
      status: row.status as ReceptionBatchStatus,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      counts: receptionCounts(row.items)
    }))
  }

  async getBatch(
    storeId: string,
    batchId: string,
    held: readonly Permission[]
  ): Promise<ReceptionBatchView> {
    const row = await this.prisma.client.returnReceptionBatch.findFirst({
      where: { id: batchId, storeId },
      select: {
        id: true,
        status: true,
        createdBy: true,
        createdAt: true,
        completedAt: true,
        items: { orderBy: [{ scannedAt: 'asc' }, { id: 'asc' }], select: receptionItemSelect }
      }
    })
    if (row === null) throw resourceNotFound('reception batch')
    return {
      id: row.id,
      status: row.status as ReceptionBatchStatus,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      // The same condition `updateItem` applies a refusal's preselection under, so the editor shows what the server will do
      cautionPreselected: mayFlag(held) && (await this.preselectsCaution(storeId)),
      counts: receptionCounts(row.items),
      items: row.items.map(item => receptionItemView(item, held))
    }
  }

  // The code a reader typed is matched against the guide numbers of the store's shipments, ignoring the case and the blanks. No
  // match, or a code that names more than one shipment, is an answer and changes nothing; a package that cannot be received is
  // a refusal with its own code.
  async scan(
    storeId: string,
    batchId: string,
    body: ScanCodeBody,
    held: readonly Permission[]
  ): Promise<ScanResultView> {
    await this.assertBatch(this.prisma.client, storeId, batchId, [ReceptionBatchStatus.DRAFT])
    const matches = await this.shipmentsNamed(storeId, body.code, body.shipmentId)
    const picked =
      body.shipmentId === undefined
        ? matches.length === 1
          ? matches[0]
          : undefined
        : matches.find(match => match.id === body.shipmentId)
    if (matches.length === 0 || (body.shipmentId !== undefined && picked === undefined)) {
      return { result: ReceptionScanResults.NOT_FOUND }
    }
    if (picked === undefined) {
      return {
        result: ReceptionScanResults.AMBIGUOUS,
        candidates: matches.slice(0, ReceptionLimits.MAX_CANDIDATES).map(candidateOf)
      }
    }
    // Said first: a package that came back leaves its order RETURNED, which would otherwise read as "not eligible"
    await this.assertNotReceived(this.prisma.client, storeId, picked.id)
    // A DELIVERED guide is a package the customer received: it is taken only after the agent confirmed that it came back anyway
    const isDelivered =
      (picked.kind as ShipmentKind) === ShipmentKind.OUTBOUND &&
      (picked.status as ShipmentStatus) === ShipmentStatus.DELIVERED
    if (
      (picked.kind as ShipmentKind) !== ShipmentKind.OUTBOUND ||
      !(isDelivered || ScannableShipmentStatuses.includes(picked.status as ShipmentStatus)) ||
      !([OrderStatus.SHIPPED, OrderStatus.DELIVERED] as string[]).includes(picked.order.status)
    ) {
      throw conflict(
        ErrorCodes.RECEPTION_SHIPMENT_NOT_ELIGIBLE,
        'no package comes back from this shipment',
        { shipmentStatus: picked.status, shipmentKind: picked.kind }
      )
    }
    // Asked after the refusals above: nobody is asked to confirm a package that would be refused anyway
    if (isDelivered && body.confirmDelivered !== true) {
      return { result: ReceptionScanResults.NEEDS_CONFIRMATION, candidate: candidateOf(picked) }
    }
    const itemId = await this.prisma
      .transaction(async tx => {
        await this.assertBatch(
          tx,
          storeId,
          batchId,
          [ReceptionBatchStatus.DRAFT],
          // Exclusive: two scans of one batch count its packages one after the other, so the cap holds
          BatchLocks.EXCLUSIVE
        )
        await this.assertNotReceived(tx, storeId, picked.id)
        const count = await tx.returnReceptionItem.count({ where: { storeId, batchId } })
        if (count >= ReceptionLimits.MAX_ITEMS) {
          throw conflict(ErrorCodes.RECEPTION_BATCH_FULL, 'the batch is full')
        }
        const created = await tx.returnReceptionItem.create({
          data: {
            storeId,
            batchId,
            shipmentId: picked.id,
            reason: ReceptionReasons.DEFAULT,
            condition: OrderReturnCondition.RESELLABLE,
            confirmDelivered: isDelivered
          },
          select: { id: true }
        })
        return created.id
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw conflict(
            ErrorCodes.RECEPTION_DUPLICATE_SCAN,
            'the shipment is already in the batch'
          )
        }
        throw error
      })
    return { result: ReceptionScanResults.ADDED, item: await this.itemView(storeId, itemId, held) }
  }

  async updateItem(
    storeId: string,
    batchId: string,
    itemId: string,
    body: UpdateReceptionItemBody,
    held: readonly Permission[]
  ): Promise<ReceptionItemView> {
    const preselect = await this.preselectsCaution(storeId)
    await this.prisma.transaction(async tx => {
      await this.assertBatch(tx, storeId, batchId, EDITABLE, BatchLocks.SHARED)
      const item = await this.ownItem(tx, storeId, batchId, itemId)
      if (item.outcome === ReceptionItemOutcome.RECEIVED) {
        // The one thing left to decide about a package that came back: drop a flag that could not be set (it would be retried
        // for ever). A flag that is already on the customer is not undone from here.
        const dropsFlag =
          body.flagCustomer === false &&
          Object.keys(body).length === 1 &&
          item.flagAppliedAt === null
        if (!dropsFlag) {
          throw conflict(ErrorCodes.RECEPTION_ALREADY_RECEIVED, 'the package was already received')
        }
        await tx.returnReceptionItem.updateMany({
          where: { id: itemId, storeId },
          data: { flagCustomer: false, flagReason: null, errorCode: null }
        })
        return
      }
      const reason = body.reason ?? item.reason
      const note = body.note === undefined ? item.note : body.note
      let flagCustomer = body.flagCustomer ?? item.flagCustomer
      // A refusal preselects the flag when the store asks for it, for who may flag; an explicit choice always wins
      if (
        body.flagCustomer === undefined &&
        body.reason === ReceptionReasons.REFUSED &&
        item.reason !== ReceptionReasons.REFUSED &&
        preselect &&
        mayFlag(held)
      ) {
        flagCustomer = true
      }
      const touchesFlag =
        flagCustomer !== item.flagCustomer ||
        (flagCustomer && body.flagReason !== undefined && body.flagReason !== item.flagReason)
      // Whoever may not flag a customer cannot decide that one is flagged, nor change the line about them
      if (flagCustomer && touchesFlag && !mayFlag(held)) {
        throw new PlatformException(
          ErrorCodes.PERMISSION_DENIED,
          'flagging a customer needs customers:flag_caution',
          HttpStatusCodes.FORBIDDEN
        )
      }
      const flagReason = flagCustomer
        ? body.flagReason === undefined
          ? item.flagReason
          : body.flagReason
        : null
      // Said when the agent decides the flag; a refusal that preselects it may still have nothing to say (the completion checks)
      const decidesFlag = body.flagCustomer === true || body.flagReason !== undefined
      if (decidesFlag && flagCustomer && flagReasonOf({ flagReason, note }) === null) {
        throw flagNeedsReason()
      }
      if (body.lines !== undefined)
        await this.assertLinesOfOrder(tx, storeId, item.shipmentId, body.lines)
      await tx.returnReceptionItem.updateMany({
        where: { id: itemId, storeId },
        data: {
          reason,
          note,
          flagCustomer,
          flagReason,
          // A package that failed and was fixed waits for the next completion again
          ...(item.outcome === ReceptionItemOutcome.FAILED
            ? { outcome: null, errorCode: null }
            : {}),
          ...(body.condition === undefined ? {} : { condition: body.condition }),
          ...(body.lines === undefined ? {} : { lines: body.lines })
        }
      })
    })
    return this.itemView(storeId, itemId, held)
  }

  async removeItem(storeId: string, batchId: string, itemId: string): Promise<void> {
    await this.prisma.transaction(async tx => {
      await this.assertBatch(tx, storeId, batchId, EDITABLE, BatchLocks.SHARED)
      const item = await this.ownItem(tx, storeId, batchId, itemId)
      if (item.outcome === ReceptionItemOutcome.RECEIVED) {
        throw conflict(ErrorCodes.RECEPTION_ALREADY_RECEIVED, 'the package was already received')
      }
      await tx.returnReceptionItem.deleteMany({ where: { id: itemId, storeId } })
    })
  }

  // Processes every package that is not received (and the flag of one that is, but whose customer is not flagged yet), one by
  // one. A package that fails is marked with its error code and the next one goes on. Calling it again retries what failed.
  async complete(
    storeId: string,
    batchId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<ReceptionBatchView> {
    const { work, claimedAt } = await this.claim(storeId, batchId, held)
    if (claimedAt === null) return this.getBatch(storeId, batchId, held)
    try {
      for (const item of work) await this.process(storeId, item, actor)
    } finally {
      await this.release(storeId, batchId, actor, claimedAt)
    }
    return this.getBatch(storeId, batchId, held)
  }

  // ------------------------------------------------------------------------------------------------------------- inside

  private async claim(storeId: string, batchId: string, held: readonly Permission[]) {
    return this.prisma.transaction(async tx => {
      await this.assertBatch(
        tx,
        storeId,
        batchId,
        [
          ReceptionBatchStatus.DRAFT,
          ReceptionBatchStatus.COMPLETED_WITH_ERRORS,
          ReceptionBatchStatus.PROCESSING
        ],
        BatchLocks.EXCLUSIVE
      )
      const items = await tx.returnReceptionItem.findMany({
        where: { storeId, batchId },
        orderBy: [{ scannedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          shipmentId: true,
          reason: true,
          condition: true,
          note: true,
          lines: true,
          flagCustomer: true,
          flagReason: true,
          confirmDelivered: true,
          outcome: true,
          returnId: true,
          flagAppliedAt: true
        }
      })
      const batchRow = await tx.returnReceptionBatch.findFirstOrThrow({
        where: { id: batchId, storeId },
        select: { status: true }
      })
      // A batch that ended with errors and has nothing left to do (the failed packages were removed, or a flag was dropped) is
      // settled by completing it again
      const settles = (batchRow.status as ReceptionBatchStatus) !== ReceptionBatchStatus.DRAFT
      if (items.length === 0 && !settles) {
        throw conflict(ErrorCodes.RECEPTION_BATCH_EMPTY, 'the batch has no packages')
      }
      const work = items.filter(
        item =>
          item.outcome !== ReceptionItemOutcome.RECEIVED ||
          (item.flagCustomer && item.flagAppliedAt === null)
      )
      if (work.length === 0) {
        if (!settles) {
          throw conflict(ErrorCodes.RECEPTION_BATCH_CLOSED, 'there is nothing left to process')
        }
        await tx.returnReceptionBatch.updateMany({
          where: { id: batchId, storeId },
          data: {
            status: ReceptionBatchStatus.COMPLETED,
            processingStartedAt: null,
            completedAt: new Date()
          }
        })
        return { work: [], claimedAt: null }
      }
      // The flag is a decision about a person: completing does not let someone without the permission carry it out
      if (work.some(item => item.flagCustomer) && !mayFlag(held)) {
        throw new PlatformException(
          ErrorCodes.PERMISSION_DENIED,
          'completing a batch with flagged customers needs customers:flag_caution',
          HttpStatusCodes.FORBIDDEN
        )
      }
      const claimedAt: Date | null = new Date()
      await tx.returnReceptionBatch.updateMany({
        where: { id: batchId, storeId },
        data: {
          status: ReceptionBatchStatus.PROCESSING,
          processingStartedAt: claimedAt,
          completedAt: null
        }
      })
      return { work, claimedAt }
    })
  }

  private async process(
    storeId: string,
    item: {
      id: string
      shipmentId: string
      reason: string
      condition: string
      note: string | null
      lines: unknown
      flagCustomer: boolean
      flagReason: string | null
      confirmDelivered: boolean
      outcome: string | null
      returnId: string | null
      flagAppliedAt: Date | null
    },
    actor: Actor
  ): Promise<void> {
    if (item.returnId === null) {
      const received = await this.receive(storeId, item, actor)
      if (!received) return
    }
    if (item.flagCustomer && item.flagAppliedAt === null) await this.flag(storeId, item, actor)
  }

  // True when the package came back. A refusal of the returns service is the item's outcome, never an error of the batch.
  private async receive(
    storeId: string,
    item: Parameters<ReturnReceptionService['process']>[1],
    actor: Actor
  ): Promise<boolean> {
    try {
      await this.assertNotReceived(this.prisma.client, storeId, item.shipmentId)
      // A flag with nothing to say is refused before the package is received, not after
      if (item.flagCustomer && flagReasonOf(item) === null) {
        throw flagNeedsReason()
      }
      const lines = receptionLinesSchema.parse(item.lines)
      const { returnId } = await this.returns.receiveFromScan(
        storeId,
        {
          shipmentId: item.shipmentId,
          reason: item.reason,
          condition: item.condition as OrderReturnCondition,
          notes: item.note ?? undefined,
          lines: lines.length === 0 ? undefined : lines,
          confirmDelivered: item.confirmDelivered
        },
        actor
      )
      await this.prisma.client.returnReceptionItem.updateMany({
        where: { id: item.id, storeId },
        data: { outcome: ReceptionItemOutcome.RECEIVED, errorCode: null, returnId }
      })
      return true
    } catch (error) {
      const code = error instanceof PlatformException ? error.code : ErrorCodes.INTERNAL_ERROR
      if (!(error instanceof PlatformException)) {
        this.logger.error(
          { err: error, itemId: item.id },
          'a scanned package failed with an unexpected error'
        )
      }
      // Only a package nobody has received: a run that lost its claim must not overwrite what the run that took over wrote
      await this.prisma.client.returnReceptionItem.updateMany({
        where: {
          id: item.id,
          storeId,
          OR: [{ outcome: null }, { outcome: ReceptionItemOutcome.FAILED }]
        },
        data: { outcome: ReceptionItemOutcome.FAILED, errorCode: code }
      })
      return false
    }
  }

  private async flag(
    storeId: string,
    item: Parameters<ReturnReceptionService['process']>[1],
    actor: Actor
  ): Promise<void> {
    try {
      const reason = flagReasonOf(item)
      if (reason === null) throw flagNeedsReason()
      const row = await this.prisma.client.returnReceptionItem.findFirstOrThrow({
        where: { id: item.id, storeId },
        select: { shipment: { select: { order: { select: { customerId: true } } } } }
      })
      const customerId = row.shipment.order.customerId
      const customer = await this.prisma.client.customer.findFirstOrThrow({
        where: { id: customerId, storeId },
        select: { isCaution: true }
      })
      // A customer who is already flagged keeps the reason and the author of the first flag: this one adds nothing to it
      if (!customer.isCaution) await this.caution.set(storeId, customerId, { reason }, actor)
      await this.prisma.client.returnReceptionItem.updateMany({
        where: { id: item.id, storeId },
        data: { flagAppliedAt: new Date(), errorCode: null }
      })
    } catch (error) {
      if (!(error instanceof PlatformException)) {
        this.logger.error(
          { err: error, itemId: item.id },
          'the customer of a scanned package could not be flagged'
        )
      }
      await this.prisma.client.returnReceptionItem.updateMany({
        where: { id: item.id, storeId },
        data: { errorCode: ErrorCodes.RECEPTION_FLAG_FAILED }
      })
    }
  }

  // Ends a run: the batch is completed when every package is received and every requested flag is set, and otherwise keeps
  // what failed for a retry
  private async release(
    storeId: string,
    batchId: string,
    actor: Actor,
    claimedAt: Date
  ): Promise<void> {
    const items = await this.prisma.client.returnReceptionItem.findMany({
      where: { storeId, batchId },
      select: { outcome: true, flagCustomer: true, flagAppliedAt: true }
    })
    const clean = items.every(
      item =>
        item.outcome === ReceptionItemOutcome.RECEIVED &&
        (!item.flagCustomer || item.flagAppliedAt !== null)
    )
    const counts = receptionCounts(items)
    // Only the run that holds the claim ends it: one that was taken over (it ran past the stale limit) leaves the batch to the new run
    const ended = await this.prisma.client.returnReceptionBatch.updateMany({
      where: {
        id: batchId,
        storeId,
        status: ReceptionBatchStatus.PROCESSING,
        processingStartedAt: claimedAt
      },
      data: {
        status: clean ? ReceptionBatchStatus.COMPLETED : ReceptionBatchStatus.COMPLETED_WITH_ERRORS,
        processingStartedAt: null,
        completedAt: new Date()
      }
    })
    if (ended.count === 0) return
    this.audit.log({
      action: AuditAction.RETURN_RECEPTION_BATCH_COMPLETED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ReturnResourceTypes.RECEPTION_BATCH,
      resourceId: batchId,
      metadata: {
        received: counts.received,
        failed: counts.failed,
        flagged: items.filter(item => item.flagAppliedAt !== null).length
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  private async itemView(
    storeId: string,
    itemId: string,
    held: readonly Permission[]
  ): Promise<ReceptionItemView> {
    const row: ReceptionItemRow = await this.prisma.client.returnReceptionItem.findFirstOrThrow({
      where: { id: itemId, storeId },
      select: receptionItemSelect
    })
    return receptionItemView(row, held)
  }

  private async preselectsCaution(storeId: string): Promise<boolean> {
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    return readStorePreferences(settings?.preferences).returns.preselectCautionOnRefusal
  }

  private async shipmentsNamed(storeId: string, code: string, shipmentId: string | undefined) {
    // Only the blanks of ASCII, as the expression of the index strips them
    const normalized = code.replace(/[ \t\n\r\f\v]+/g, '').toLowerCase()
    // The same expression as the index of shipments (store, guide without blanks and in lower case)
    const ids = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM shipments
      WHERE store_id = ${storeId}
        AND lower(regexp_replace(guide_number, '[[:space:]]', '', 'g')) = ${normalized}
        AND (${shipmentId ?? null}::text IS NULL OR id = ${shipmentId ?? null}::text)
      ORDER BY id
      LIMIT ${ReceptionLimits.MAX_CANDIDATES + 1}`
    if (ids.length === 0) return []
    return this.prisma.client.shipment.findMany({
      where: { storeId, id: { in: ids.map(row => row.id) } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        kind: true,
        status: true,
        guideNumber: true,
        order: { select: { orderNumber: true, status: true } }
      }
    })
  }

  // Checks the status of the batch, and locks its row for the length of the transaction when `lock` is set (shared for a change to its
  // packages, exclusive to claim it), so a package cannot be added to a batch that is being completed. A completion that has run
  // longer than ReceptionLimits.PROCESSING_STALE_MS died with its process: only a new completion may take the batch over.
  private async assertBatch(
    client: Pick<PrismaTransaction, '$queryRaw'>,
    storeId: string,
    batchId: string,
    allowed: readonly string[],
    lock: BatchLock = BatchLocks.NONE
  ): Promise<void> {
    const rows =
      lock === BatchLocks.EXCLUSIVE
        ? await client.$queryRaw<BatchRow[]>`
            SELECT status, processing_started_at AS started FROM return_reception_batches
            WHERE id = ${batchId} AND store_id = ${storeId} FOR UPDATE`
        : lock === BatchLocks.SHARED
          ? await client.$queryRaw<BatchRow[]>`
              SELECT status, processing_started_at AS started FROM return_reception_batches
              WHERE id = ${batchId} AND store_id = ${storeId} FOR SHARE`
          : await client.$queryRaw<BatchRow[]>`
              SELECT status, processing_started_at AS started FROM return_reception_batches
              WHERE id = ${batchId} AND store_id = ${storeId}`
    const row = rows[0]
    if (row === undefined) throw resourceNotFound('reception batch')
    if (row.status === (ReceptionBatchStatus.PROCESSING as string)) {
      const stale =
        row.started !== null &&
        Date.now() - row.started.getTime() > ReceptionLimits.PROCESSING_STALE_MS
      if (!stale) {
        throw conflict(ErrorCodes.RECEPTION_BATCH_PROCESSING, 'the batch is being completed')
      }
    }
    if (!allowed.includes(row.status)) {
      throw conflict(ErrorCodes.RECEPTION_BATCH_CLOSED, 'the batch does not take that now')
    }
  }

  private async assertNotReceived(
    client: Pick<PrismaTransaction, 'returnReceptionItem'>,
    storeId: string,
    shipmentId: string
  ): Promise<void> {
    const already = await client.returnReceptionItem.findFirst({
      where: { storeId, shipmentId, outcome: ReceptionItemOutcome.RECEIVED },
      select: { id: true }
    })
    if (already !== null) {
      throw conflict(ErrorCodes.RECEPTION_ALREADY_RECEIVED, 'the package was already received')
    }
  }

  private async ownItem(tx: PrismaTransaction, storeId: string, batchId: string, itemId: string) {
    const item = await tx.returnReceptionItem.findFirst({
      where: { id: itemId, batchId, storeId },
      select: {
        shipmentId: true,
        reason: true,
        note: true,
        outcome: true,
        flagCustomer: true,
        flagReason: true,
        flagAppliedAt: true
      }
    })
    if (item === null) throw resourceNotFound('reception item')
    return item
  }

  // The lines name units of the order the package belongs to, each once
  private async assertLinesOfOrder(
    tx: PrismaTransaction,
    storeId: string,
    shipmentId: string,
    lines: readonly ReceptionLine[]
  ): Promise<void> {
    const shipment = await tx.shipment.findFirstOrThrow({
      where: { id: shipmentId, storeId },
      select: { order: { select: { items: { select: { id: true } } } } }
    })
    const own = new Set(shipment.order.items.map(item => item.id))
    const seen = new Set<string>()
    for (const line of lines) {
      if (!own.has(line.orderItemId) || seen.has(line.orderItemId)) {
        throw invalid('the lines must name each unit of the order once')
      }
      seen.add(line.orderItemId)
    }
  }
}
