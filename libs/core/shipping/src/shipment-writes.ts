import { Injectable } from '@nestjs/common'

import type { PrismaTransaction } from '@platform/core/database'
import {
  CodStatus,
  CodVoidingStatuses,
  expectedCodCents,
  PickupStatus,
  PickupStatusTransitions,
  ShipmentEventSource,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { type ActorRef, Events } from '@platform/core/events'

import { isShipmentTransitionAllowed } from './shipment-rules'

// The only writes of the status of a shipment and of a pickup (TDD_17 §3): a lint rule keeps every other file out of
// them. Each move checks the table of transitions, writes with the status it read in the `where` (so a change that raced
// this one is seen as a conflict, never overwritten), records the history row and announces the change once it commits.

// Which shipment a move is about, as far as the events it raises need to say
export interface ShipmentIdentity {
  shipmentId: string
  storeId: string
  orderId: string
  orderNumber: string
  connectionId: string
}

// The columns a move may set together with the status (never a status of another table)
export interface ShipmentMoveData {
  guideNumber?: string
  providerShipmentId?: string | null
  trackingUrl?: string | null
  labelMediaId?: string | null
  carrierCostCents?: number | null
  refundStatus?: string
  pickupId?: string | null
  lastError?: string | null
  failedAttempts?: { increment: number }
  cancelRequestedAt?: Date
  cancelledAt?: Date
}

export interface ShipmentMoveMeta {
  actor: ActorRef
  source: ShipmentEventSource
  description?: string | undefined
  occurredAt?: Date | undefined
  providerEventId?: string | undefined
  rawStatus?: string | undefined
  // A redacted extract of what the carrier sent (never an address or a phone, TDD_17 §4.12)
  payload?: Record<string, string | number | boolean | null> | undefined
  // The move applies an event that was kept and is read again (the replay of TDD_17 §4.17): what hears it writes to the team
  // only, never to the customer
  replay?: boolean | undefined
}

function conflict(message: string): PlatformException {
  return new PlatformException(
    ErrorCodes.SHIPPING_INVALID_STATUS_TRANSITION,
    message,
    HttpStatusCodes.CONFLICT
  )
}

@Injectable()
export class ShipmentWrites {
  constructor(private readonly events: DomainEvents) {}

  // Writes a shipment that was never written before: the first row of its history says it was made
  async insertCreating(
    tx: PrismaTransaction,
    row: Parameters<PrismaTransaction['shipment']['create']>[0]['data'],
    actor: ActorRef
  ): Promise<string> {
    const created = await tx.shipment.create({
      data: { ...row, status: ShipmentStatus.CREATING },
      select: { id: true, storeId: true }
    })
    await tx.shipmentEvent.create({
      data: {
        storeId: created.storeId,
        shipmentId: created.id,
        status: ShipmentStatus.CREATING,
        occurredAt: new Date(),
        source: ShipmentEventSource.SYSTEM,
        payload: { actorId: actor.id }
      }
    })
    return created.id
  }

  // One forward step of one shipment. Throws SHIPPING_INVALID_STATUS_TRANSITION (409) when the table does not allow it or
  // when the row is no longer in the status it was read in.
  async move(
    tx: PrismaTransaction,
    identity: ShipmentIdentity,
    from: ShipmentStatus,
    to: ShipmentStatus,
    data: ShipmentMoveData,
    meta: ShipmentMoveMeta
  ): Promise<void> {
    if (!isShipmentTransitionAllowed(from, to)) {
      throw conflict(`a shipment cannot go from ${from} to ${to}`)
    }
    const moved = await tx.shipment.updateMany({
      where: { id: identity.shipmentId, storeId: identity.storeId, status: from },
      data: { ...data, status: to }
    })
    if (moved.count === 0) throw conflict('the shipment changed while this was happening')
    if (to === ShipmentStatus.DELIVERED) await this.settleDelivery(tx, identity, meta.occurredAt)
    // A package that is cancelled, or on its way back, never brings the cash that was due on delivery
    if (CodVoidingStatuses.includes(to)) await this.voidUndeliveredCod(tx, identity)
    await tx.shipmentEvent.create({
      data: {
        storeId: identity.storeId,
        shipmentId: identity.shipmentId,
        status: to,
        occurredAt: meta.occurredAt ?? new Date(),
        source: meta.source,
        ...(meta.description === undefined ? {} : { description: meta.description }),
        ...(meta.providerEventId === undefined ? {} : { providerEventId: meta.providerEventId }),
        ...(meta.rawStatus === undefined ? {} : { rawStatus: meta.rawStatus }),
        payload: { actorId: meta.actor.id, from, ...(meta.payload ?? {}) }
      }
    })
    this.announce(tx, identity, from, to, meta.actor, meta.replay === true)
  }

  // A package that arrived: it keeps the day, and a cash-on-delivery one now holds money for the carrier to remit, which it
  // is expected to bring net of the carrier's fee only when the rule of §4.15 says so; a prepaid one has none
  private async settleDelivery(
    tx: PrismaTransaction,
    identity: ShipmentIdentity,
    occurredAt: Date | undefined
  ): Promise<void> {
    const now = new Date()
    const at = occurredAt !== undefined && occurredAt < now ? occurredAt : now
    const row = await tx.shipment.findFirst({
      where: { id: identity.shipmentId, storeId: identity.storeId },
      select: {
        codStatus: true,
        codAmountCents: true,
        carrierCostCents: true,
        carrierRateCents: true,
        commissionBps: true,
        shippingPayer: true,
        connection: { select: { remittanceDeductsFee: true } }
      }
    })
    if (row === null) return
    await tx.shipment.updateMany({
      where: { id: identity.shipmentId, storeId: identity.storeId, deliveredAt: null },
      data: { deliveredAt: at }
    })
    if (row.codStatus !== String(CodStatus.NOT_DELIVERED) || row.codAmountCents === null) return
    await tx.shipment.updateMany({
      where: {
        id: identity.shipmentId,
        storeId: identity.storeId,
        codStatus: CodStatus.NOT_DELIVERED
      },
      data: {
        codStatus: CodStatus.PENDING_REMITTANCE,
        codExpectedCents: expectedCodCents({
          codAmountCents: row.codAmountCents,
          carrierCostCents: row.carrierCostCents,
          carrierRateCents: row.carrierRateCents,
          commissionBps: row.commissionBps,
          shippingPayer: row.shippingPayer as ShippingPayer,
          deductsFee: row.connection.remittanceDeductsFee
        })
      }
    })
  }

  // Nothing was collected: a cash-on-delivery package that was never delivered has nothing to remit (§4.15). A delivered one
  // keeps its status, because the cash was collected and any refund is settled by hand (§4.16). Returns whether it voided.
  // The returns of Step 4.12 call this for a package that comes back; the moves above call it for the status of the carrier.
  async voidUndeliveredCod(
    tx: PrismaTransaction,
    identity: Pick<ShipmentIdentity, 'shipmentId' | 'storeId'>
  ): Promise<boolean> {
    const voided = await tx.shipment.updateMany({
      where: {
        id: identity.shipmentId,
        storeId: identity.storeId,
        codStatus: CodStatus.NOT_DELIVERED
      },
      data: { codStatus: CodStatus.VOID }
    })
    return voided.count > 0
  }

  // A line of the history with no move: an event that arrived too late, or says what the platform does not take from a
  // carrier. The status of the shipment stays as it is and nothing is announced.
  async recordHistory(
    tx: PrismaTransaction,
    identity: ShipmentIdentity,
    status: ShipmentStatus | null,
    meta: ShipmentMoveMeta
  ): Promise<void> {
    await tx.shipmentEvent.create({
      data: {
        storeId: identity.storeId,
        shipmentId: identity.shipmentId,
        status,
        occurredAt: meta.occurredAt ?? new Date(),
        source: meta.source,
        ...(meta.description === undefined ? {} : { description: meta.description }),
        ...(meta.providerEventId === undefined ? {} : { providerEventId: meta.providerEventId }),
        ...(meta.rawStatus === undefined ? {} : { rawStatus: meta.rawStatus }),
        payload: { actorId: meta.actor.id, ...(meta.payload ?? {}) }
      }
    })
  }

  // A pickup moves the same way, with its own table. It announces nothing itself: the caller that ends a pickup in a state that needs a person publishes `pickup.manual_required`.
  async movePickup(
    tx: PrismaTransaction,
    storeId: string,
    pickupId: string,
    from: PickupStatus,
    to: PickupStatus,
    data: {
      providerPickupId?: string | null
      packageCount?: number
      carrierPackageCount?: number | null
      lastError?: string | null
    }
  ): Promise<void> {
    if (!PickupStatusTransitions[from].includes(to)) {
      throw conflict(`a pickup cannot go from ${from} to ${to}`)
    }
    const moved = await tx.pickupRequest.updateMany({
      where: { id: pickupId, storeId, status: from },
      data: { ...data, status: to }
    })
    if (moved.count === 0) throw conflict('the pickup changed while this was happening')
  }

  private announce(
    tx: PrismaTransaction,
    identity: ShipmentIdentity,
    from: ShipmentStatus,
    to: ShipmentStatus,
    actor: ActorRef,
    replay: boolean
  ): void {
    const common = {
      storeId: identity.storeId,
      shipmentId: identity.shipmentId,
      orderId: identity.orderId,
      orderNumber: identity.orderNumber,
      connectionId: identity.connectionId,
      actor
    }
    this.events.publish(tx, Events.SHIPMENT_STATUS_CHANGED, {
      ...common,
      from,
      to,
      ...(replay ? { replay } : {})
    })
    // A guide made is announced once: when it first reaches LABEL_CREATED
    if (to === ShipmentStatus.LABEL_CREATED)
      this.events.publish(tx, Events.SHIPMENT_CREATED, common)
    if (to === ShipmentStatus.REQUIRES_REVIEW) {
      this.events.publish(tx, Events.SHIPMENT_REQUIRES_REVIEW, common)
    }
    if (to === ShipmentStatus.CANCELLED) this.events.publish(tx, Events.SHIPMENT_CANCELLED, common)
    if (to === ShipmentStatus.CANCEL_FAILED) {
      this.events.publish(tx, Events.SHIPMENT_CANCEL_FAILED, common)
    }
  }

  // A guide the carrier has no way to void stays CANCEL_PENDING (nothing moves) and the agent is told to void it there
  announceCancelByHand(tx: PrismaTransaction, identity: ShipmentIdentity, actor: ActorRef): void {
    this.events.publish(tx, Events.SHIPMENT_CANCEL_FAILED, {
      storeId: identity.storeId,
      shipmentId: identity.shipmentId,
      orderId: identity.orderId,
      orderNumber: identity.orderNumber,
      connectionId: identity.connectionId,
      actor
    })
  }
}
