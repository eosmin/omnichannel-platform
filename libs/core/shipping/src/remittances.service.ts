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
  RemittanceDestinationProblem,
  remittanceDestinationProblem,
  RemittanceLineOutcome,
  RemittanceLockScopes,
  ShipmentKind,
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

export interface DifferenceWrittenOff {
  shipmentId: string
  connectionId: string
  remittanceId: string
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

  // `source` is what an import adds: the profile that read the file and the file kept as evidence (a client never names them)
  async createDraft(
    storeId: string,
    body: CreateRemittanceBody,
    actor: ActorRef,
    source: { importProfileId?: string; sourceMediaId?: string } = {}
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
          ...(body.note === undefined ? {} : { note: body.note }),
          ...(source.importProfileId === undefined
            ? {}
            : { importProfileId: source.importProfileId }),
          ...(source.sourceMediaId === undefined ? {} : { sourceMediaId: source.sourceMediaId })
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
          ErrorCodes.REMITTANCE_TOO_MANY_LINES,
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
      if (body.destinationAccountId !== undefined) {
        await this.assertDestination(tx, storeId, body.destinationAccountId)
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
      const current = await tx.shipment.findMany({
        where: { storeId, id: { in: settling.map(line => line.shipmentId ?? '') } },
        select: { id: true, codStatus: true }
      })
      const statusOf = new Map(current.map(row => [row.id, row.codStatus as CodStatus]))
      // What earlier confirmed remittances paid for each guide: the guide keeps the running total, and the full amount it was expected
      // to bring (this line was held against what was left)
      const paidBefore = await this.remittedBefore(
        tx,
        storeId,
        settling.map(line => line.shipmentId ?? '')
      )
      const settles = settling.map(line => {
        const differs = line.outcome === String(RemittanceLineOutcome.AMOUNT_DIFFERS)
        const next = differs ? CodStatus.DISCREPANCY : CodStatus.REMITTED
        if (differs) discrepancies += 1
        const from = statusOf.get(line.shipmentId ?? '')
        // A shipment in discrepancy that still differs stays in it, with the newer amount and remittance
        if (from === undefined || (from !== next && !CodStatusTransitions[from].includes(next))) {
          throw refusal(
            ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
            'a shipment changed while the remittance was being confirmed'
          )
        }
        const paid = paidBefore.get(line.shipmentId ?? '') ?? 0
        return {
          id: line.shipmentId,
          from,
          next,
          reported: paid + line.reportedCents,
          expected: line.expectedCents === null ? null : line.expectedCents + paid
        }
      })
      // One statement for every shipment, each held to the status it was read in: a count short of the lines means one changed
      const settled = await tx.$executeRaw`
        UPDATE shipments s
        SET cod_status = v.next, cod_remitted_cents = v.reported, cod_remittance_id = ${remittanceId},
            cod_expected_cents = COALESCE(v.expected, s.cod_expected_cents), updated_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(settles)}::jsonb) AS v(id text, "from" text, next text, reported int, expected int)
        WHERE s.id = v.id AND s.store_id = ${storeId} AND s.cod_status = v."from"`
      if (settled !== settles.length) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          'a shipment changed while the remittance was being confirmed'
        )
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
          ...(body.note === undefined ? {} : { note: body.note }),
          ...(body.destinationAccountId === undefined
            ? {}
            : { destinationAccountId: body.destinationAccountId })
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

  // The account the money goes to (TDD_18 §4.2 E5), checked in the transaction of the confirmation: an account of the organization of the
  // store that the books can post to and that is cash, a bank or a wallet. One of another organization is not found.
  private async assertDestination(
    tx: PrismaTransaction,
    storeId: string,
    accountId: string
  ): Promise<void> {
    const account = await tx.ledgerAccount.findFirst({
      where: { id: accountId, organization: { stores: { some: { id: storeId } } } },
      select: { active: true, isPostable: true, cashKind: true }
    })
    if (account === null) throw resourceNotFound('account')
    const problem = remittanceDestinationProblem(account)
    if (problem === RemittanceDestinationProblem.INACTIVE) {
      throw refusal(ErrorCodes.FINANCE_ACCOUNT_INACTIVE, 'the account is not active')
    }
    if (problem === RemittanceDestinationProblem.NOT_CASH) {
      throw new PlatformException(
        ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE,
        'the money of a remittance goes to a cash, bank or wallet account',
        HttpStatusCodes.BAD_REQUEST
      )
    }
  }

  // A confirmed remittance can be voided: its shipments go back to waiting for a remittance and it stays as the evidence of what
  // was undone. A shipment that a later remittance settled again is not touched (it names the later one).
  async void(
    storeId: string,
    remittanceId: string,
    actor: ActorRef,
    reason?: string
  ): Promise<RemittanceVoided> {
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
      // The write-off of a guide cleared what this remittance left open: voiding the remittance would open it again with the guide gone
      // from the list of what can be remitted, so it is refused until the write-off is undone by hand (a reversal of the accountant)
      // (any guide a line of this remittance settled, not only the one that names it: an earlier remittance of a guide written off later
      // cleared part of what the write-off worked out)
      const writtenOff = await tx.codRemittanceLine.count({
        where: {
          remittanceId,
          storeId,
          excluded: false,
          outcome: { in: [...SettlingOutcomes] },
          shipment: { codStatus: CodStatus.WRITTEN_OFF }
        }
      })
      if (writtenOff > 0) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          'a remittance with a written-off difference cannot be voided'
        )
      }
      // The settling lines of this remittance and of the others for the same guides, in the order they were confirmed
      const guideIds = (
        await tx.codRemittanceLine.findMany({
          where: {
            storeId,
            remittanceId,
            excluded: false,
            shipmentId: { not: null },
            outcome: { in: [...SettlingOutcomes] }
          },
          select: { shipmentId: true }
        })
      ).flatMap(line => (line.shipmentId === null ? [] : [line.shipmentId]))
      const others = await tx.codRemittanceLine.findMany({
        where: {
          storeId,
          shipmentId: { in: guideIds },
          excluded: false,
          outcome: { in: [...SettlingOutcomes] },
          remittanceId: { not: remittanceId },
          remittance: { storeId, status: RemittanceStatus.CONFIRMED }
        },
        orderBy: [{ remittance: { confirmedAt: 'asc' } }, { remittanceId: 'asc' }],
        select: {
          shipmentId: true,
          remittanceId: true,
          reportedCents: true,
          remittance: { select: { confirmedAt: true } }
        }
      })
      const mine = await tx.codRemittance.findFirst({
        where: { id: remittanceId, storeId },
        select: { confirmedAt: true }
      })
      // A guide's running total is the sum of its remittances: taking out one that is not the last would leave the others wrong
      const laterOnes = others.filter(
        other =>
          mine?.confirmedAt != null &&
          other.remittance.confirmedAt !== null &&
          (other.remittance.confirmedAt > mine.confirmedAt ||
            (other.remittance.confirmedAt.getTime() === mine.confirmedAt.getTime() &&
              other.remittanceId > remittanceId))
      )
      if (laterOnes.length > 0) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          'a later remittance paid the same guides: void that one first'
        )
      }
      const earlier = new Map<string, { total: number; lastRemittanceId: string }>()
      for (const other of others) {
        if (other.shipmentId === null) continue
        const seen = earlier.get(other.shipmentId)
        earlier.set(other.shipmentId, {
          total: (seen?.total ?? 0) + other.reportedCents,
          lastRemittanceId: other.remittanceId
        })
      }
      const held = await tx.shipment.findMany({
        where: {
          storeId,
          codRemittanceId: remittanceId,
          codStatus: { in: [CodStatus.REMITTED, CodStatus.DISCREPANCY] }
        },
        select: { id: true, codExpectedCents: true }
      })
      // Most guides had no earlier remittance: one statement for all of them (a file can carry thousands of guides)
      const fresh = held.filter(guide => !earlier.has(guide.id)).map(guide => guide.id)
      const reset = await tx.shipment.updateMany({
        where: { id: { in: fresh }, storeId, codRemittanceId: remittanceId },
        data: {
          codStatus: CodStatus.PENDING_REMITTANCE,
          codRemittedCents: null,
          codRemittanceId: null
        }
      })
      let restored = reset.count
      // A guide that an earlier remittance had paid in part goes back to the state that one gave it
      for (const guide of held) {
        const before = earlier.get(guide.id)
        if (before === undefined) continue
        const done = await tx.shipment.updateMany({
          where: { id: guide.id, storeId, codRemittanceId: remittanceId },
          data: {
            codStatus:
              guide.codExpectedCents === before.total ? CodStatus.REMITTED : CodStatus.DISCREPANCY,
            codRemittedCents: before.total,
            codRemittanceId: before.lastRemittanceId
          }
        })
        restored += done.count
      }
      const voided = await tx.codRemittance.updateMany({
        where: { id: remittanceId, storeId, status: RemittanceStatus.CONFIRMED },
        data: {
          status: RemittanceStatus.VOIDED,
          voidedAt: new Date(),
          voidedBy: actor.id ?? 'system',
          ...(reason === undefined ? {} : { voidReason: reason })
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
      return { remittanceId, connectionId: row.connectionId, restored }
    })
  }

  // The difference of a guide that did not match its remittance is written off: the guide is closed with a status of its own and the
  // books clear what the carrier still owes for it (TDD_18 §4.2 E7, posted by the finance listener from the event). Only a guide in
  // discrepancy, only once: the update is conditional, so two people clicking write off once.
  async writeOffDifference(
    storeId: string,
    shipmentId: string,
    actor: ActorRef
  ): Promise<DifferenceWrittenOff> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const shipment = await tx.shipment.findFirst({
        where: { id: shipmentId, storeId, kind: ShipmentKind.OUTBOUND },
        select: { connectionId: true, codStatus: true, codRemittanceId: true }
      })
      if (shipment === null) throw resourceNotFound('shipment')
      if (
        shipment.codStatus !== String(CodStatus.DISCREPANCY) ||
        shipment.codRemittanceId === null
      ) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          'only a guide in discrepancy can have its difference written off'
        )
      }
      const done = await tx.shipment.updateMany({
        where: {
          id: shipmentId,
          storeId,
          codStatus: CodStatus.DISCREPANCY,
          codRemittanceId: shipment.codRemittanceId
        },
        data: { codStatus: CodStatus.WRITTEN_OFF }
      })
      if (done.count === 0) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          'the guide changed while its difference was being written off'
        )
      }
      this.events.publish(tx, Events.REMITTANCE_DIFFERENCE_WRITTEN_OFF, {
        storeId,
        shipmentId,
        connectionId: shipment.connectionId,
        actor
      })
      return {
        shipmentId,
        connectionId: shipment.connectionId,
        remittanceId: shipment.codRemittanceId
      }
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
      if (draft.status === String(RemittanceStatus.CONFIRMED)) {
        throw refusal(
          ErrorCodes.REMITTANCE_ALREADY_CONFIRMED,
          'only a draft can be changed: a confirmed remittance is immutable'
        )
      }
      if (draft.status !== String(RemittanceStatus.DRAFT)) {
        throw refusal(
          ErrorCodes.REMITTANCE_INVALID_STATUS_TRANSITION,
          `a ${draft.status} remittance cannot be changed`
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

  // What the confirmed remittances (not voided ones) already paid for each guide: the sum of what their settling lines reported. The
  // books add the same lines, so the guide's own figures (what is owed, what was remitted, its status) agree with them.
  private async remittedBefore(
    tx: PrismaTransaction,
    storeId: string,
    shipmentIds: readonly string[]
  ): Promise<Map<string, number>> {
    if (shipmentIds.length === 0) return new Map()
    const rows = await tx.codRemittanceLine.groupBy({
      by: ['shipmentId'],
      where: {
        storeId,
        shipmentId: { in: [...shipmentIds] },
        excluded: false,
        outcome: { in: [...SettlingOutcomes] },
        remittance: { storeId, status: RemittanceStatus.CONFIRMED }
      },
      _sum: { reportedCents: true }
    })
    return new Map(
      rows.flatMap(row =>
        row.shipmentId === null ? [] : [[row.shipmentId, row._sum.reportedCents ?? 0] as const]
      )
    )
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
        carrier_rate_cents: number | null
        commission_bps: number | null
        shipping_payer: string
      }[]
    >`
      SELECT id, guide_number, cod_status, cod_amount_cents, cod_expected_cents, carrier_cost_cents,
             carrier_rate_cents, commission_bps, shipping_payer
      FROM shipments
      WHERE store_id = ${storeId} AND connection_id = ${draft.connectionId} AND kind = ${ShipmentKind.OUTBOUND}
        AND guide_number IS NOT NULL AND lower(regexp_replace(guide_number, '^\\s+|\\s+$', '', 'g')) = ANY(${keys}::text[])`
    const byKey = new Map<string, typeof shipments>()
    for (const row of shipments) {
      const key = guideKey(row.guide_number)
      byKey.set(key, [...(byKey.get(key) ?? []), row])
    }
    const before = await this.remittedBefore(
      tx,
      storeId,
      shipments.map(row => row.id)
    )
    const seen = new Set<string>()
    const changes: {
      id: string
      outcome: RemittanceLineOutcome
      expected_cents: number | null
      shipment_id: string | null
    }[] = []
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
              carrierRateCents: found.carrier_rate_cents,
              commissionBps: found.commission_bps,
              shippingPayer: found.shipping_payer as ShippingPayer
            }
      const result = classifyLine(
        {
          reportedCents: line.reportedCents,
          reportedFeeCents: line.reportedFeeCents,
          duplicate: seen.has(found?.id ?? key),
          remittedBeforeCents: found === undefined ? 0 : (before.get(found.id) ?? 0),
          shipment
        },
        deductsFee
      )
      // A line left out does not hold the guide: the next one for it counts
      if (!line.excluded) seen.add(found?.id ?? key)
      const shipmentId = found?.id ?? null
      if (
        String(result.outcome) !== line.outcome ||
        result.expectedCents !== line.expectedCents ||
        shipmentId !== line.shipmentId
      ) {
        changes.push({
          id: line.id,
          outcome: result.outcome,
          expected_cents: result.expectedCents,
          shipment_id: shipmentId
        })
      }
    }
    if (changes.length === 0) return
    // One statement for every line that changed: a file of 5,000 rows must not cost 5,000 round trips inside one transaction
    await tx.$executeRaw`
      UPDATE cod_remittance_lines l
      SET outcome = v.outcome, expected_cents = v.expected_cents, shipment_id = v.shipment_id
      FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb)
        AS v(id text, outcome text, expected_cents int, shipment_id text)
      WHERE l.id = v.id AND l.store_id = ${storeId}`
  }
}
