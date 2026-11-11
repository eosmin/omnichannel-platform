import { Injectable } from '@nestjs/common'

import {
  lockStoreForWrite,
  lockStoreScope,
  type PrismaTransaction,
  PrismaService
} from '@platform/core/database'
import {
  CarrierConnectionStatus,
  CarrierEventOutcomes,
  type CarrierEventOutcome,
  CarrierMovableStatuses,
  ShipmentEventSource,
  ShipmentKind,
  ShipmentLockScopes,
  ShipmentStatus
} from '@platform/core/domain'
import type { ActorRef } from '@platform/core/events'

import { isShipmentTransitionAllowed } from './shipment-rules'
import { ShipmentWrites } from './shipment-writes'

function sourceOf(value: string): ShipmentEventSource {
  return (
    Object.values(ShipmentEventSource).find(source => String(source) === value) ??
    ShipmentEventSource.WEBHOOK
  )
}

// Applies again an event that was kept with no status, now that the owner has said what its code means (TDD_17 §4.17). It is
// the same decision as for a new event (the transition table, the connection that must be live, a moment that is a moment of
// the shipment's life, `failedAttempts`) with two differences. The history line already exists, so it is the one that is
// settled (given its status), not a second line next to it; and what the move announces carries `replay`, so nobody writes to
// the customer about a package that may have arrived days ago. A line that no longer fits (a later event already moved the
// shipment past it) gets its status and moves nothing, like any event out of order. Each line is one transaction: a replay
// that stops halfway keeps what it did and the next run finds only the lines that are left.
@Injectable()
export class ShipmentReplayer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: ShipmentWrites
  ) {}

  async replay(
    storeId: string,
    eventId: string,
    status: ShipmentStatus
  ): Promise<CarrierEventOutcome> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const stored = await tx.shipmentEvent.findFirst({
        where: { id: eventId, storeId, status: null },
        select: {
          id: true,
          shipmentId: true,
          rawStatus: true,
          description: true,
          occurredAt: true,
          providerEventId: true,
          source: true
        }
      })
      // Settled already (by an earlier run, or by the carrier telling it again): nothing is left to do
      if (stored === null) return CarrierEventOutcomes.DUPLICATE
      const known = await tx.shipment.findFirst({
        where: { id: stored.shipmentId, storeId, kind: ShipmentKind.OUTBOUND },
        select: { orderId: true }
      })
      if (known === null) return CarrierEventOutcomes.IGNORED
      await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${known.orderId}`)
      const row = await tx.shipment.findFirst({
        where: { id: stored.shipmentId, storeId },
        select: {
          id: true,
          storeId: true,
          orderId: true,
          connectionId: true,
          status: true,
          createdAt: true,
          order: { select: { orderNumber: true } },
          connection: { select: { status: true } }
        }
      })
      if (row === null || row.connection.status !== String(CarrierConnectionStatus.ACTIVE)) {
        return CarrierEventOutcomes.IGNORED
      }
      // The carrier told the same event again after the code was mapped, and it was applied as a new one: this line is its twin, and
      // settling it would write the event twice (and count a failed attempt twice)
      const twin = await tx.shipmentEvent.findFirst({
        where: {
          storeId,
          shipmentId: stored.shipmentId,
          id: { not: stored.id },
          ...(stored.providerEventId === null
            ? { occurredAt: stored.occurredAt, status }
            : { providerEventId: stored.providerEventId, status: { not: null } })
        },
        select: { id: true }
      })
      if (twin !== null) {
        await tx.shipmentEvent.deleteMany({ where: { id: stored.id, storeId } })
        return CarrierEventOutcomes.DUPLICATE
      }
      const from = row.status as ShipmentStatus
      const movable =
        CarrierMovableStatuses.includes(status) &&
        stored.occurredAt >= row.createdAt &&
        isShipmentTransitionAllowed(from, status)
      if (!movable) {
        await this.settle(tx, storeId, stored.id, status)
        return CarrierEventOutcomes.STORED
      }
      const actor: ActorRef = { type: 'system', id: null }
      // The line is taken out and written again by the move, in the same transaction: the index of the provider id never sees
      // two of them, and the history keeps one line for the event, now with its status
      await tx.shipmentEvent.deleteMany({ where: { id: stored.id, storeId } })
      await this.writes.move(
        tx,
        {
          shipmentId: row.id,
          storeId: row.storeId,
          orderId: row.orderId,
          orderNumber: row.order.orderNumber,
          connectionId: row.connectionId
        },
        from,
        status,
        status === ShipmentStatus.FAILED_ATTEMPT ? { failedAttempts: { increment: 1 } } : {},
        {
          actor,
          // The line keeps where it came from: a webhook or a poll
          source: sourceOf(stored.source),
          description: stored.description ?? undefined,
          occurredAt: stored.occurredAt,
          providerEventId: stored.providerEventId ?? undefined,
          rawStatus: stored.rawStatus ?? undefined,
          replay: true
        }
      )
      return CarrierEventOutcomes.APPLIED
    })
  }

  private async settle(
    tx: PrismaTransaction,
    storeId: string,
    eventId: string,
    status: ShipmentStatus
  ): Promise<void> {
    await tx.shipmentEvent.updateMany({
      where: { id: eventId, storeId, status: null },
      data: { status }
    })
  }
}
