import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  CarrierCapability,
  CarrierConnectionStatus,
  cancelShipmentKey,
  GuideRefundStatus,
  PickupLeaveNotes,
  PickupStatus,
  ShipmentEventSource,
  ShipmentFailureReasons,
  ShipmentInactiveStatuses,
  ShipmentLockScopes,
  ShipmentPastPickupStatuses,
  ShipmentStatus,
  ShipmentUnknownOutcomeStatuses
} from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import type { ActorRef } from '@platform/core/events'
import {
  CarrierRejectedError,
  type CancelShipmentResult,
  type CarrierPlugin
} from '@platform/plugins/sdk'

import { withDeadline } from './carrier-call'
import { buildCarrierContext } from './carrier-context'
import type { PluginLookup } from './shipment-prepare'
import {
  classifyCarrierError,
  clampCarrierMessage,
  failureReasonOf,
  mayRetryVoid
} from './shipment-rules'
import { type ShipmentIdentity, ShipmentWrites } from './shipment-writes'

// A cancel that asked nobody (the process died after it was written) may be asked again after this, never before: the call
// may still be in flight. It is longer than the whole schedule of the job (five calls of up to 30 s with pauses of 30, 60, 120
// and 240 s: ten minutes), so a request never finds a job that is still retrying and takes it for a forgotten one.
const CANCEL_STALE_MS = 15 * 60 * 1000

export interface VoidChange {
  shipmentId: string
  orderId: string
  from: ShipmentStatus
  to: ShipmentStatus
}

// A void that has to be asked of the carrier: the caller queues `CANCEL_SHIPMENT` for it once its transaction committed
export interface VoidJob {
  shipmentId: string
  requestedAt: Date
}

export interface VoidStart {
  change: VoidChange
  job: VoidJob | null
}

// What a settled void came to: the job ends on all but `retry`, which asks the queue to try again
export const VoidSettlements = {
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  RETRY: 'retry',
  SKIPPED: 'skipped'
} as const
export type VoidSettlement = (typeof VoidSettlements)[keyof typeof VoidSettlements]

export interface VoidSettleOptions {
  actor: ActorRef
  // The queue will not ask again: a carrier that did not answer ends as CANCEL_FAILED
  lastAttempt: boolean
}

// The pickup a cancelled guide left, as far as the carrier has to be told
interface PickupLeft {
  pickupId: string
  connectionId: string
  remaining: number
  status: PickupStatus
  providerPickupId: string | null
}

const SELECT = {
  id: true,
  storeId: true,
  orderId: true,
  connectionId: true,
  status: true,
  guideNumber: true,
  providerShipmentId: true,
  idempotencyKey: true,
  cancelRequestedAt: true,
  refundStatus: true,
  pickupId: true,
  order: { select: { orderNumber: true } },
  connection: {
    select: { id: true, carrierId: true, status: true, credentials: true, contact: true }
  }
} as const

type ConnectionInput = Parameters<typeof buildCarrierContext>[0]

interface Row {
  id: string
  storeId: string
  orderId: string
  connectionId: string
  status: string
  guideNumber: string | null
  providerShipmentId: string | null
  idempotencyKey: string
  cancelRequestedAt: Date | null
  refundStatus: string
  pickupId: string | null
  order: { orderNumber: string }
  connection: {
    id: string
    carrierId: string
    status: string
    credentials: ConnectionInput['credentials']
    contact: ConnectionInput['contact']
  }
}

function conflict(message: string): PlatformException {
  return new PlatformException(
    ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION,
    message,
    HttpStatusCodes.CONFLICT
  )
}

function identityOf(row: Row): ShipmentIdentity {
  return {
    shipmentId: row.id,
    storeId: row.storeId,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    connectionId: row.connectionId
  }
}

// Voiding a guide (TDD_17 §4.8): starting it (the shipment is CANCEL_PENDING, a guide with `CarrierCapability.INTERNAL_GUIDE` is cancelled at once, a carrier
// that cannot void is left for the agent), settling it with the carrier (the job, with its retries), and "mark as voided" by
// hand. A guide that is voided leaves its pickup. The status is moved only through `ShipmentWrites`.
@Injectable()
export class ShipmentCancellation {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly writes: ShipmentWrites,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ShipmentCancellation.name)
  }

  // POST /shipments/:id/cancel: one guide, in a transaction of its own. A refusal is a 409; a second request for a guide that is
  // already being voided is refused too (the carrier is not asked twice).
  async cancel(
    storeId: string,
    shipmentId: string,
    actor: ActorRef,
    plugins: PluginLookup
  ): Promise<VoidStart> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      return this.start(tx, storeId, shipmentId, actor, plugins, { refusePending: true })
    })
  }

  // Starts the void inside the transaction of the caller (an order that is cancelled or edited takes the store and order locks
  // first). The carrier is never called here: a guide that needs it comes back as a job to queue after the commit.
  async start(
    tx: PrismaTransaction,
    storeId: string,
    shipmentId: string,
    actor: ActorRef,
    plugins: PluginLookup,
    options: { refusePending: boolean }
  ): Promise<VoidStart> {
    const row = await this.lockedRow(tx, storeId, shipmentId)
    const from = row.status as ShipmentStatus
    const unchanged: VoidChange = { shipmentId, orderId: row.orderId, from, to: from }
    if (ShipmentUnknownOutcomeStatuses.includes(from)) {
      throw new PlatformException(
        ErrorCodes.SHIPPING_OUTCOME_UNKNOWN,
        'a guide may exist: resolve it first',
        HttpStatusCodes.CONFLICT,
        { shipmentId }
      )
    }
    if (ShipmentPastPickupStatuses.includes(from)) {
      throw new PlatformException(
        ErrorCodes.SHIPPING_CANNOT_CANCEL_AFTER_PICKUP,
        'the package has left',
        HttpStatusCodes.CONFLICT,
        { shipmentId }
      )
    }
    if (ShipmentInactiveStatuses.includes(from)) {
      if (options.refusePending)
        throw conflict(`a shipment cannot go from ${from} to cancel_pending`)
      return { change: unchanged, job: null }
    }
    // A void that failed is settled by an agent (retry or "mark as voided"): an order that is cancelled or edited does not ask the
    // carrier again behind their back
    if (from === ShipmentStatus.CANCEL_FAILED && !options.refusePending) {
      return { change: unchanged, job: null }
    }
    if (from === ShipmentStatus.CANCEL_PENDING) {
      // Asked again only when nobody can be asking: the carrier could be reached and said nothing was done, or the process that
      // asked is long gone (a guide the carrier cannot void is `not_supported`: nobody is asking and nobody ever will)
      const asked = row.cancelRequestedAt
      const forgotten =
        row.refundStatus !== String(GuideRefundStatus.NOT_SUPPORTED) &&
        asked !== null &&
        Date.now() - asked.getTime() >= CANCEL_STALE_MS
      if (!forgotten) {
        if (options.refusePending) throw conflict('the guide is already being cancelled')
        return { change: unchanged, job: null }
      }
      const requestedAt = new Date()
      await tx.shipment.updateMany({
        where: { id: shipmentId, storeId, status: ShipmentStatus.CANCEL_PENDING },
        data: { cancelRequestedAt: requestedAt }
      })
      return { change: unchanged, job: { shipmentId, requestedAt } }
    }

    const plugin = plugins(row.connection.carrierId)
    const internal = plugin?.capabilities.includes(CarrierCapability.INTERNAL_GUIDE) === true
    const askable = this.canAskCarrier(row, plugin)
    const requestedAt = new Date()
    const meta = { actor, source: ShipmentEventSource.MANUAL } as const
    await this.writes.move(
      tx,
      identityOf(row),
      from,
      ShipmentStatus.CANCEL_PENDING,
      {
        cancelRequestedAt: requestedAt,
        lastError: null,
        ...(internal || askable ? {} : { refundStatus: GuideRefundStatus.NOT_SUPPORTED })
      },
      meta
    )
    if (internal) {
      // A guide with `CarrierCapability.INTERNAL_GUIDE` is ours: nobody has to be asked and nothing is refunded
      await this.writes.move(
        tx,
        identityOf(row),
        ShipmentStatus.CANCEL_PENDING,
        ShipmentStatus.CANCELLED,
        {
          cancelledAt: new Date(),
          refundStatus: GuideRefundStatus.NOT_APPLICABLE,
          pickupId: null
        },
        meta
      )
      await this.leavePickup(tx, row)
      return { change: { ...unchanged, to: ShipmentStatus.CANCELLED }, job: null }
    }
    const change = { ...unchanged, to: ShipmentStatus.CANCEL_PENDING }
    if (!askable) {
      // The carrier has no way to void it (or its connection is gone): the agent voids it there and presses "mark as voided"
      this.writes.announceCancelByHand(tx, identityOf(row), actor)
      return { change, job: null }
    }
    return { change, job: { shipmentId, requestedAt } }
  }

  // The job: asks the carrier once. A guide that is not CANCEL_PENDING any more (voided by hand, or by an earlier run of this
  // job) is left alone, so the job is safe to run twice.
  async settle(
    storeId: string,
    shipmentId: string,
    plugins: PluginLookup,
    options: VoidSettleOptions
  ): Promise<VoidSettlement> {
    const row = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId, storeId },
      select: SELECT
    })
    if (row === null || row.status !== String(ShipmentStatus.CANCEL_PENDING)) {
      return VoidSettlements.SKIPPED
    }
    const plugin = plugins(row.connection.carrierId)
    const guideNumber = row.guideNumber
    const cancelCall = plugin?.cancelShipment?.bind(plugin)
    if (
      plugin === undefined ||
      cancelCall === undefined ||
      guideNumber === null ||
      !this.canAskCarrier(row, plugin)
    ) {
      // Nothing to ask of this carrier any more (it was disconnected since): the agent settles it
      await this.finish(
        storeId,
        row,
        ShipmentStatus.CANCEL_PENDING,
        ShipmentStatus.CANCEL_PENDING,
        {
          actor: options.actor,
          data: { refundStatus: GuideRefundStatus.NOT_SUPPORTED },
          tellTeam: true
        }
      )
      return VoidSettlements.FAILED
    }
    let answer: CancelShipmentResult
    try {
      const context = buildCarrierContext(
        {
          id: row.connection.id,
          storeId,
          credentials: row.connection.credentials,
          contact: row.connection.contact
        },
        this.cipher
      )
      answer = await withDeadline(() =>
        cancelCall(context, {
          reference: row.order.orderNumber,
          guideNumber,
          ...(row.providerShipmentId === null
            ? {}
            : { providerShipmentId: row.providerShipmentId }),
          idempotencyKey: cancelShipmentKey(row.idempotencyKey)
        })
      )
    } catch (error) {
      if (mayRetryVoid(error) && !options.lastAttempt) return VoidSettlements.RETRY
      // The carrier refused, or never answered: the shipment keeps holding the order until the agent settles it
      const reason =
        error instanceof CarrierRejectedError
          ? clampCarrierMessage(error.message)
          : failureReasonOf(classifyCarrierError(error))
      await this.finish(storeId, row, ShipmentStatus.CANCEL_PENDING, ShipmentStatus.CANCEL_FAILED, {
        actor: options.actor,
        data: { lastError: reason }
      })
      return VoidSettlements.FAILED
    }
    let left: PickupLeft | null
    try {
      left = await this.finish(
        storeId,
        row,
        ShipmentStatus.CANCEL_PENDING,
        ShipmentStatus.CANCELLED,
        {
          actor: options.actor,
          data: {
            cancelledAt: new Date(),
            lastError: null,
            pickupId: null,
            // Only what the contract allows is kept: a plugin that says anything else is read as a refund still pending
            refundStatus:
              typeof answer === 'object' &&
              answer !== null &&
              answer.refundStatus === GuideRefundStatus.CONFIRMED
                ? GuideRefundStatus.CONFIRMED
                : GuideRefundStatus.PENDING
          }
        }
      )
    } catch (error) {
      // An agent marked it voided while the carrier was being asked: the guide is where the job wanted it
      if (
        error instanceof PlatformException &&
        error.code === ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION
      ) {
        return VoidSettlements.SKIPPED
      }
      throw error
    }
    await this.tellCarrierOfPickup(storeId, left, plugins).catch(() => undefined)
    return VoidSettlements.CANCELLED
  }

  // The void could not be handed to the queue (it was down): the guide is left CANCEL_FAILED, which tells the team, and an
  // agent asks again from there (a retry moves it back to CANCEL_PENDING and queues the job)
  async markNotQueued(storeId: string, shipmentId: string, actor: ActorRef): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const row = await this.lockedRow(tx, storeId, shipmentId)
      if (row.status !== String(ShipmentStatus.CANCEL_PENDING)) return
      await this.writes.move(
        tx,
        identityOf(row),
        ShipmentStatus.CANCEL_PENDING,
        ShipmentStatus.CANCEL_FAILED,
        { lastError: ShipmentFailureReasons.NOT_QUEUED },
        { actor, source: ShipmentEventSource.SYSTEM }
      )
    })
  }

  // The agent voided the guide at the carrier herself: HIGH-tier, audited (TDD_17 §4.8)
  async markVoided(
    storeId: string,
    shipmentId: string,
    actor: ActorRef,
    plugins: PluginLookup
  ): Promise<VoidChange> {
    const done = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const row = await this.lockedRow(tx, storeId, shipmentId)
      const from = row.status as ShipmentStatus
      await this.writes.move(
        tx,
        identityOf(row),
        from,
        ShipmentStatus.CANCELLED,
        { cancelledAt: new Date(), lastError: null, pickupId: null },
        { actor, source: ShipmentEventSource.MANUAL }
      )
      const left = await this.leavePickup(tx, row)
      return {
        left,
        change: { shipmentId, orderId: row.orderId, from, to: ShipmentStatus.CANCELLED }
      }
    })
    await this.tellCarrierOfPickup(storeId, done.left, plugins).catch(() => undefined)
    return done.change
  }

  // ---------------------------------------------------------------------------------------------- support

  // A carrier can be asked to void when its plugin can, the connection is live and the guide has a number
  private canAskCarrier(row: Row, plugin: CarrierPlugin | undefined): boolean {
    return (
      plugin !== undefined &&
      plugin.cancelShipment !== undefined &&
      plugin.capabilities.includes(CarrierCapability.CANCEL_SHIPMENT) &&
      row.connection.status === String(CarrierConnectionStatus.ACTIVE) &&
      row.guideNumber !== null
    )
  }

  private async finish(
    storeId: string,
    row: Row,
    from: ShipmentStatus,
    to: ShipmentStatus,
    result: {
      actor: ActorRef
      data: Parameters<ShipmentWrites['move']>[4]
      tellTeam?: boolean
    }
  ): Promise<PickupLeft | null> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Locked before it is read again: a hand that voided it meanwhile is seen
      await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${row.orderId}`)
      if (from === to) {
        // Nothing moves: the guide stays CANCEL_PENDING for the agent, who is told
        const moved = await tx.shipment.updateMany({
          where: { id: row.id, storeId, status: from },
          data: result.data
        })
        if (moved.count > 0 && result.tellTeam === true) {
          this.writes.announceCancelByHand(tx, identityOf(row), result.actor)
        }
        return null
      }
      await this.writes.move(tx, identityOf(row), from, to, result.data, {
        actor: result.actor,
        source: ShipmentEventSource.MANUAL
      })
      return to === ShipmentStatus.CANCELLED ? this.leavePickup(tx, row) : null
    })
  }

  private async lockedRow(
    tx: PrismaTransaction,
    storeId: string,
    shipmentId: string
  ): Promise<Row> {
    const first = await tx.shipment.findFirst({
      where: { id: shipmentId, storeId },
      select: { orderId: true }
    })
    if (first === null) throw resourceNotFound('shipment')
    await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${first.orderId}`)
    // Read again with the lock held: a change that raced this one is seen
    const row = await tx.shipment.findFirst({ where: { id: shipmentId, storeId }, select: SELECT })
    if (row === null) throw resourceNotFound('shipment')
    return row
  }

  // The guide leaves its pickup (TDD_17 §4.8): the count of the pickup drops to the guides that still hold it. A pickup nobody
  // has asked a carrier for is cancelled here when it is empty; one the carrier knows is told after the commit.
  private async leavePickup(tx: PrismaTransaction, row: Row): Promise<PickupLeft | null> {
    if (row.pickupId === null) return null
    const pickup = await tx.pickupRequest.findFirst({
      where: { id: row.pickupId, storeId: row.storeId },
      select: { id: true, connectionId: true, status: true, providerPickupId: true }
    })
    if (pickup === null) return null
    const current = pickup.status as PickupStatus
    // A pickup that is over keeps what it was
    if (current === PickupStatus.CANCELLED || current === PickupStatus.FAILED) return null
    // The packages that are left: the sum of the package counts of the guides that still hold the pickup (TDD_17 §4.10)
    const held = await tx.shipment.aggregate({
      _sum: { packageCount: true },
      where: {
        storeId: row.storeId,
        pickupId: pickup.id,
        id: { not: row.id },
        status: { notIn: [...ShipmentInactiveStatuses] }
      }
    })
    const remaining = held._sum.packageCount ?? 0
    await tx.pickupRequest.updateMany({
      where: { id: pickup.id, storeId: row.storeId },
      data: { packageCount: remaining, revision: { increment: 1 } }
    })
    const status = current
    if (remaining === 0 && status === PickupStatus.MANUAL_REQUIRED) {
      await this.writes.movePickup(tx, row.storeId, pickup.id, status, PickupStatus.CANCELLED, {})
    } else if (
      remaining === 0 &&
      (status === PickupStatus.PENDING || status === PickupStatus.REQUIRES_REVIEW)
    ) {
      // A request that may exist at the carrier and has no packages any more: the agent settles it there
      await tx.pickupRequest.updateMany({
        where: { id: pickup.id, storeId: row.storeId },
        data: { lastError: PickupLeaveNotes.EMPTY_NOT_CANCELLED }
      })
    }
    return {
      pickupId: pickup.id,
      connectionId: pickup.connectionId,
      remaining,
      status,
      providerPickupId: pickup.providerPickupId
    }
  }

  // After the commit: a pickup the carrier holds is told how many packages it has now, or is cancelled when it is empty. A
  // carrier that cannot, or that does not answer, leaves a note on the pickup for the agent; the guide is voided either way.
  private async tellCarrierOfPickup(
    storeId: string,
    left: PickupLeft | null,
    plugins: PluginLookup
  ): Promise<void> {
    if (
      left === null ||
      left.providerPickupId === null ||
      (left.status !== PickupStatus.REQUESTED && left.status !== PickupStatus.CONFIRMED)
    ) {
      return
    }
    const note = (lastError: string): Promise<unknown> =>
      this.prisma.client.pickupRequest.updateMany({
        where: { id: left.pickupId, storeId },
        data: { lastError }
      })
    try {
      const connection = await this.prisma.client.carrierConnection.findFirst({
        where: { id: left.connectionId, storeId },
        select: { id: true, carrierId: true, status: true, credentials: true, contact: true }
      })
      const plugin = connection === null ? undefined : plugins(connection.carrierId)
      const empty = left.remaining === 0
      const wanted = empty ? CarrierCapability.PICKUP_CANCEL : CarrierCapability.PICKUP_MODIFY
      if (
        connection === null ||
        plugin === undefined ||
        connection.status !== String(CarrierConnectionStatus.ACTIVE) ||
        !plugin.capabilities.includes(wanted)
      ) {
        await note(empty ? PickupLeaveNotes.EMPTY_NOT_CANCELLED : PickupLeaveNotes.NOT_UPDATED)
        return
      }
      const context = buildCarrierContext(
        {
          id: connection.id,
          storeId,
          credentials: connection.credentials,
          contact: connection.contact
        },
        this.cipher
      )
      const pickupRef = left.providerPickupId
      if (empty && plugin.cancelPickup !== undefined) {
        const cancelPickup = plugin.cancelPickup.bind(plugin)
        await withDeadline(() => cancelPickup(context, { pickupRef }))
        // The carrier did cancel it: a pickup that moved meanwhile is not a reason to tell the agent otherwise
        await this.prisma
          .transaction(async tx => {
            await lockStoreForWrite(tx, storeId)
            await this.writes.movePickup(
              tx,
              storeId,
              left.pickupId,
              left.status,
              PickupStatus.CANCELLED,
              { lastError: null }
            )
          })
          .catch((error: unknown) => {
            this.logger.warn(
              { pickupId: left.pickupId, errorName: errorName(error) },
              'a pickup the carrier cancelled changed meanwhile'
            )
          })
      } else if (!empty && plugin.modifyPickup !== undefined) {
        const modifyPickup = plugin.modifyPickup.bind(plugin)
        await withDeadline(() => modifyPickup(context, { pickupRef, packageCount: left.remaining }))
        // What the carrier now holds is what it was told, whatever the guides hold by the time this lands: a pickup told out of
        // order is told again by the resync (`PickupSync`)
        await this.prisma.client.pickupRequest.updateMany({
          where: { id: left.pickupId, storeId },
          data: { carrierPackageCount: left.remaining }
        })
      } else {
        await note(empty ? PickupLeaveNotes.EMPTY_NOT_CANCELLED : PickupLeaveNotes.NOT_UPDATED)
      }
    } catch (error) {
      this.logger.warn(
        { pickupId: left.pickupId, errorName: errorName(error) },
        'the carrier could not be told that a guide left its pickup'
      )
      // The note is a courtesy: a database that cannot take it must not fail a guide that is already voided
      await note(
        left.remaining === 0 ? PickupLeaveNotes.EMPTY_NOT_CANCELLED : PickupLeaveNotes.NOT_UPDATED
      ).catch(() => undefined)
    }
  }
}
