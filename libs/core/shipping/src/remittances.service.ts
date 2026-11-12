import { Injectable } from '@nestjs/common'

import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  type AddRemittanceLinesBody,
  classifyLine,
  CodStatus,
  CodStatusTransitions,
  type ConfirmRemittanceBody,
  type CreateRemittanceBody,
  guideKey,
  type MatchShipment,
  RemittanceLimits,
  RemittanceLineOutcome,
  RemittanceLockScopes,
  type RemittanceLineInput,
  RemittanceStatus,
  RemittanceStatusTransitions,
  remittanceTotals,
  SettlingOutcomes,
  ShippingPayer,
  type UpdateRemittanceLineBody
} from '@platform/core/domain'
import {
  type ErrorCode,
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { type ActorRef, Events } from '@platform/core/events'

// What a confirmation or a void did, for the audit entry the api writes
export interface RemittanceSettlement {
  remittanceId: string
  connectionId: string
  settled: number
  discrepancies: number
  expectedCents: number
  reportedCents: number
  feeCents: number
}

export interface RemittanceVoided {
  remittanceId: string
  connectionId: string
  restored: number
}

type Draft = { id: string; connectionId: string; status: string }

function refusal(code: ErrorCode, message: string): PlatformException {
  return new PlatformException(code, message, HttpStatusCodes.CONFLICT)
}

// The only writer of a remittance and of the COD status a remittance gives a shipment (TDD_17 §4.15; the lint rule keeps every
// other file out of them). A draft is built by hand or from an import; confirming settles the shipments in ONE transaction
// under a lock per store and connection, and a confirmed remittance is never edited: it can only be voided.
@Injectable()
export class RemittancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents
  ) {}

  // ---------------------------------------------------------------------------------------------------- the draft

  async createDraft(
    storeId: string,
    body: CreateRemittanceBody,
    actor: ActorRef
  ): Promise<{ id: string }> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const connection = await tx.carrierConnection.findFirst({
        where: { id: body.connectionId, storeId },
        select: { id: true }
      })
      if (connection === null) throw resourceNotFound('carrier connection')
      const created = await tx.codRemittance.create({
        data: {
          storeId,
          connectionId: connection.id,
          status: RemittanceStatus.DRAFT,
          createdBy: actor.id ?? 'system',
          ...(body.reference === undefined ? {} : { reference: body.reference }),
          ...(body.receivedOn === undefined
            ? {}
            : { receivedOn: new Date(`${body.receivedOn}T00:00:00.000Z`) }),
          ...(body.note === undefined ? {} : { note: body.note })
        },
        select: { id: true }
      })
      if (body.lines.length > 0) {
        await this.appendLines(tx, storeId, created.id, body.lines)
        await this.classifyAll(tx, storeId, {
          id: created.id,
          connectionId: connection.id,
          status: RemittanceStatus.DRAFT
        })
      }
      return created
    })
  }

  // More lines for a draft: the ones the carrier's file omitted, added by hand
  async addLines(
    storeId: string,
    remittanceId: string,
    body: AddRemittanceLinesBody
  ): Promise<void> {
    await this.inDraft(storeId, remittanceId, async (tx, draft) => {
      const count = await tx.codRemittanceLine.count({ where: { storeId, remittanceId } })
      if (count + body.lines.length > RemittanceLimits.MAX_LINES) {
        throw new PlatformException(
          ErrorCodes.REMITTANCE_IMPORT_INVALID,
          'a remittance holds at most the lines of one settlement file',
          HttpStatusCodes.BAD_REQUEST
        )
      }
      await this.appendLines(tx, storeId, remittanceId, body.lines)
      await this.classifyAll(tx, storeId, draft)
    })
  }

  // Leaves a line out of the confirmation, annotates it, or corrects what the carrier reported
  async updateLine(
    storeId: string,
    remittanceId: string,
    lineId: string,
    patch: UpdateRemittanceLineBody
  ): Promise<void> {
    await this.inDraft(storeId, remittanceId, async (tx, draft) => {
      const moved = await tx.codRemittanceLine.updateMany({
        where: { id: lineId, storeId, remittanceId },
        data: {
          ...(patch.excluded === undefined ? {} : { excluded: patch.excluded }),
          ...(patch.note === undefined ? {} : { note: patch.note }),
          ...(patch.reportedCents === undefined ? {} : { reportedCents: patch.reportedCents }),
          ...(patch.reportedFeeCents === undefined
            ? {}
            : { reportedFeeCents: patch.reportedFeeCents })
        }
      })
      if (moved.count === 0) throw resourceNotFound('remittance line')
      await this.classifyAll(tx, storeId, draft)
    })
  }

  // A draft nobody wants goes away with its lines; a confirmed one never does (it can only be voided)
  async discardDraft(storeId: string, remittanceId: string): Promise<void> {
    await this.inDraft(storeId, remittanceId, async tx => {
      await tx.codRemittance.deleteMany({
        where: { id: remittanceId, storeId, status: RemittanceStatus.DRAFT }
      })
    })
  }

  // ------------------------------------------------------------------------------------------------ the settlement

  // Confirms a draft: every line is matched again against the shipments as they are NOW (another remittance may have settled one
  // since the draft was made), the matching ones are marked remitted, the differing ones are marked as a discrepancy, the three
  // totals are written and the remittance becomes immutable. All of it in one transaction under the lock of the connection:
  // two confirmations that overlap end with one, the second one finding the remittance already confirmed.
  async confirm(
    storeId: string,
    remittanceId: string,
    body: ConfirmRemittanceBody,
    actor: ActorRef
  ): Promise<RemittanceSettlement> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const draft = await this.lockedRemittance(tx, storeId, remittanceId)
      if (draft.status === String(RemittanceStatus.CONFIRMED)) {
        throw refusal(
          ErrorCodes.REMITTANCE_ALREADY_CONFIRMED,
          'the remittance is already confirmed'
        )
      }
      if (
        !RemittanceStatusTransitions[draft.status as RemittanceStatus].includes(
          RemittanceStatus.CONFIRMED
        )
      ) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          `a ${draft.status} remittance cannot be confirmed`
        )
      }
      await this.classifyAll(tx, storeId, draft)
      const lines = await tx.codRemittanceLine.findMany({
        where: { storeId, remittanceId },
        orderBy: { position: 'asc' }
      })
      const settling = lines.filter(
        line =>
          !line.excluded &&
          line.shipmentId !== null &&
          SettlingOutcomes.includes(line.outcome as RemittanceLineOutcome)
      )
      if (settling.length === 0) {
        throw refusal(ErrorCodes.REMITTANCE_NOTHING_TO_SETTLE, 'no line settles a shipment')
      }
      let discrepancies = 0
      for (const line of settling) {
        const differs = line.outcome === String(RemittanceLineOutcome.AMOUNT_DIFFERS)
        const next = differs ? CodStatus.DISCREPANCY : CodStatus.REMITTED
        if (differs) discrepancies += 1
        const current = await tx.shipment.findFirst({
          where: { id: line.shipmentId ?? '', storeId },
          select: { codStatus: true }
        })
        // A shipment in discrepancy that still differs stays in it, with the newer amount and remittance
        const stays = current?.codStatus === next
        if (
          current === null ||
          (!stays && !CodStatusTransitions[current.codStatus as CodStatus].includes(next))
        ) {
          throw refusal(
            ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
            'a shipment changed while the remittance was being confirmed'
          )
        }
        const moved = await tx.shipment.updateMany({
          where: {
            id: line.shipmentId ?? '',
            storeId,
            codStatus: current.codStatus
          },
          data: {
            codStatus: next,
            codRemittedCents: line.reportedCents,
            codRemittanceId: remittanceId
          }
        })
        if (moved.count === 0) {
          throw refusal(
            ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
            'a shipment changed while the remittance was being confirmed'
          )
        }
      }
      const totals = remittanceTotals(
        lines.map(line => ({
          outcome: line.outcome as RemittanceLineOutcome,
          excluded: line.excluded,
          reportedCents: line.reportedCents,
          reportedFeeCents: line.reportedFeeCents,
          expectedCents: line.expectedCents
        }))
      )
      const confirmed = await tx.codRemittance.updateMany({
        where: { id: remittanceId, storeId, status: RemittanceStatus.DRAFT },
        data: {
          status: RemittanceStatus.CONFIRMED,
          expectedCents: totals.expectedCents,
          reportedCents: totals.reportedCents,
          feeCents: totals.feeCents,
          confirmedAt: new Date(),
          confirmedBy: actor.id ?? 'system',
          ...(body.reference === undefined ? {} : { reference: body.reference }),
          ...(body.receivedOn === undefined
            ? {}
            : { receivedOn: new Date(`${body.receivedOn}T00:00:00.000Z`) }),
          ...(body.note === undefined ? {} : { note: body.note })
        }
      })
      if (confirmed.count === 0) {
        throw refusal(
          ErrorCodes.REMITTANCE_ALREADY_CONFIRMED,
          'the remittance is already confirmed'
        )
      }
      this.events.publish(tx, Events.REMITTANCE_CONFIRMED, {
        storeId,
        remittanceId,
        connectionId: draft.connectionId,
        actor
      })
      return {
        remittanceId,
        connectionId: draft.connectionId,
        settled: settling.length,
        discrepancies,
        expectedCents: totals.expectedCents,
        reportedCents: totals.reportedCents,
        feeCents: totals.feeCents
      }
    })
  }

  // A confirmed remittance can be voided: its shipments go back to waiting for a remittance and it stays as the evidence of what
  // was undone. A shipment that a later remittance settled again is not touched (it names the later one).
  async void(storeId: string, remittanceId: string, actor: ActorRef): Promise<RemittanceVoided> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const row = await this.lockedRemittance(tx, storeId, remittanceId)
      if (
        !RemittanceStatusTransitions[row.status as RemittanceStatus].includes(
          RemittanceStatus.VOIDED
        )
      ) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          `a ${row.status} remittance cannot be voided`
        )
      }
      const restored = await tx.shipment.updateMany({
        where: {
          storeId,
          codRemittanceId: remittanceId,
          codStatus: { in: [CodStatus.REMITTED, CodStatus.DISCREPANCY] }
        },
        data: {
          codStatus: CodStatus.PENDING_REMITTANCE,
          codRemittedCents: null,
          codRemittanceId: null
        }
      })
      const voided = await tx.codRemittance.updateMany({
        where: { id: remittanceId, storeId, status: RemittanceStatus.CONFIRMED },
        data: {
          status: RemittanceStatus.VOIDED,
          voidedAt: new Date(),
          voidedBy: actor.id ?? 'system'
        }
      })
      if (voided.count === 0) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          'the remittance changed while it was being voided'
        )
      }
      this.events.publish(tx, Events.REMITTANCE_VOIDED, {
        storeId,
        remittanceId,
        connectionId: row.connectionId,
        actor
      })
      return { remittanceId, connectionId: row.connectionId, restored: restored.count }
    })
  }

  // ------------------------------------------------------------------------------------------------------ support

  // Runs a change of a draft under the lock of its connection, so that it cannot meet a confirmation half way
  private async inDraft(
    storeId: string,
    remittanceId: string,
    work: (tx: PrismaTransaction, draft: Draft) => Promise<void>
  ): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const draft = await this.lockedRemittance(tx, storeId, remittanceId)
      if (draft.status !== String(RemittanceStatus.DRAFT)) {
        throw refusal(
          ErrorCodes.REMITTANCE_ALREADY_CONFIRMED,
          'only a draft can be changed: a confirmed remittance is immutable'
        )
      }
      await work(tx, draft)
    })
  }

  // The remittance, read after the lock of its connection is held: a change that committed while this one waited is seen
  private async lockedRemittance(
    tx: PrismaTransaction,
    storeId: string,
    remittanceId: string
  ): Promise<Draft> {
    const first = await tx.codRemittance.findFirst({
      where: { id: remittanceId, storeId },
      select: { connectionId: true }
    })
    if (first === null) throw resourceNotFound('remittance')
    await lockStoreScope(tx, storeId, `${RemittanceLockScopes.CONNECTION}:${first.connectionId}`)
    const row = await tx.codRemittance.findFirst({
      where: { id: remittanceId, storeId },
      select: { id: true, connectionId: true, status: true }
    })
    if (row === null) throw resourceNotFound('remittance')
    return row
  }

  private async appendLines(
    tx: PrismaTransaction,
    storeId: string,
    remittanceId: string,
    lines: readonly RemittanceLineInput[]
  ): Promise<void> {
    const last = await tx.codRemittanceLine.aggregate({
      where: { storeId, remittanceId },
      _max: { position: true }
    })
    const start = (last._max.position ?? 0) + 1
    await tx.codRemittanceLine.createMany({
      data: lines.map((line, index) => ({
        storeId,
        remittanceId,
        position: start + index,
        guideNumber: line.guideNumber,
        reportedCents: line.reportedCents,
        reportedFeeCents: line.reportedFeeCents ?? null,
        note: line.note ?? null,
        // Worked out by the matching right after
        outcome: RemittanceLineOutcome.NOT_FOUND
      }))
    })
  }

  // Matches every line of the draft against the shipments of its connection by guide number (ignoring case and the whitespace
  // around it) and writes the outcome, the expected amount and the shipment of each line that changed. Of two lines for the
  // same guide the first counts and the second is a duplicate.
  private async classifyAll(tx: PrismaTransaction, storeId: string, draft: Draft): Promise<void> {
    const lines = await tx.codRemittanceLine.findMany({
      where: { storeId, remittanceId: draft.id },
      orderBy: { position: 'asc' }
    })
    if (lines.length === 0) return
    const connection = await tx.carrierConnection.findFirst({
      where: { id: draft.connectionId, storeId },
      select: { remittanceDeductsFee: true }
    })
    const deductsFee = connection?.remittanceDeductsFee ?? false
    const keys = [...new Set(lines.map(line => guideKey(line.guideNumber)))]
    const shipments = await tx.$queryRaw<
      {
        id: string
        guide_number: string
        cod_status: string
        cod_amount_cents: number | null
        cod_expected_cents: number | null
        carrier_cost_cents: number | null
        shipping_payer: string
      }[]
    >`
      SELECT id, guide_number, cod_status, cod_amount_cents, cod_expected_cents, carrier_cost_cents, shipping_payer
      FROM shipments
      WHERE store_id = ${storeId} AND connection_id = ${draft.connectionId} AND kind = 'outbound'
        AND guide_number IS NOT NULL AND lower(btrim(guide_number)) = ANY(${keys}::text[])`
    const byKey = new Map<string, typeof shipments>()
    for (const row of shipments) {
      const key = guideKey(row.guide_number)
      byKey.set(key, [...(byKey.get(key) ?? []), row])
    }
    const seen = new Set<string>()
    for (const line of lines) {
      const key = guideKey(line.guideNumber)
      const candidates = byKey.get(key) ?? []
      // Two guides that differ only in case: the exact one wins, and a guess is never made
      const found =
        candidates.length === 1
          ? candidates[0]
          : candidates.find(row => row.guide_number === line.guideNumber.trim())
      const shipment: MatchShipment | null =
        found === undefined
          ? null
          : {
              codStatus: found.cod_status as CodStatus,
              codAmountCents: found.cod_amount_cents,
              codExpectedCents: found.cod_expected_cents,
              carrierCostCents: found.carrier_cost_cents,
              shippingPayer: found.shipping_payer as ShippingPayer
            }
      const result = classifyLine(
        {
          reportedCents: line.reportedCents,
          reportedFeeCents: line.reportedFeeCents,
          duplicate: seen.has(key),
          shipment
        },
        deductsFee
      )
      seen.add(key)
      const shipmentId = found?.id ?? null
      if (
        String(result.outcome) !== line.outcome ||
        result.expectedCents !== line.expectedCents ||
        shipmentId !== line.shipmentId
      ) {
        await tx.codRemittanceLine.update({
          where: { id: line.id },
          data: { outcome: result.outcome, expectedCents: result.expectedCents, shipmentId }
        })
      }
    }
  }
}
