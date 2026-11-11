import { Injectable } from '@nestjs/common'

import {
  isUniqueViolation,
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
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

import { clampCarrierMessage, isShipmentTransitionAllowed } from './shipment-rules'
import { ShipmentWrites } from './shipment-writes'

// What a carrier said about a package, already read into the platform's own status by the plugin (or by the mapping of the
// connection): `status` is never null here, a status nobody could map is the processor's to record, not the engine's
export interface CarrierStatusEvent {
  status: ShipmentStatus
  rawStatus: string
  occurredAt: Date
  providerEventId?: string | undefined
  description?: string | undefined
}

// The one place a status coming from a carrier is turned into a move (TDD_17 §4.9). A webhook, a poll and the replay of stored
// events all arrive here, so each of them dedupes, orders and counts the same way. It writes through ShipmentWrites, which
// checks the table and announces the change: the order, the notifications and the team hear it from there, never from here.
@Injectable()
export class ShipmentStatusEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writes: ShipmentWrites
  ) {}

  async apply(
    storeId: string,
    shipmentId: string,
    event: CarrierStatusEvent,
    source: typeof ShipmentEventSource.WEBHOOK | typeof ShipmentEventSource.POLL
  ): Promise<CarrierEventOutcome> {
    if (Number.isNaN(event.occurredAt.getTime())) return CarrierEventOutcomes.IGNORED
    // Most of a re-polled history is twins: they are found before the store is locked, and again under the lock
    if (await this.isTwin(storeId, shipmentId, event)) return CarrierEventOutcomes.DUPLICATE
    try {
      return await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        const known = await tx.shipment.findFirst({
          where: { id: shipmentId, storeId, kind: ShipmentKind.OUTBOUND },
          select: { orderId: true }
        })
        if (known === null) return CarrierEventOutcomes.IGNORED
        await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${known.orderId}`)
        const row = await tx.shipment.findFirst({
          where: { id: shipmentId, storeId },
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
        // A disconnected connection has no say any more: its events are dropped (TDD_17 §4.9)
        if (row === null || row.connection.status !== String(CarrierConnectionStatus.ACTIVE)) {
          return CarrierEventOutcomes.IGNORED
        }
        // The same event again changes nothing: by its id, or by its status and moment when the carrier sends none
        if (await this.isTwin(storeId, shipmentId, event, tx)) return CarrierEventOutcomes.DUPLICATE

        const identity = {
          shipmentId: row.id,
          storeId: row.storeId,
          orderId: row.orderId,
          orderNumber: row.order.orderNumber,
          connectionId: row.connectionId
        }
        const actor: ActorRef = { type: 'system', id: null }
        const meta = {
          actor,
          source,
          occurredAt: event.occurredAt,
          rawStatus: clampCarrierMessage(event.rawStatus),
          ...(event.providerEventId === undefined
            ? {}
            : { providerEventId: event.providerEventId }),
          ...(event.description === undefined
            ? {}
            : { description: clampCarrierMessage(event.description) })
        }
        const from = row.status as ShipmentStatus
        // A moment before the guide existed is not a moment of its life: it is kept, it moves nothing
        const movable =
          CarrierMovableStatuses.includes(event.status) &&
          event.occurredAt >= row.createdAt &&
          isShipmentTransitionAllowed(from, event.status)
        if (!movable) {
          await this.writes.recordHistory(tx, identity, event.status, meta)
          return CarrierEventOutcomes.STORED
        }
        await this.writes.move(
          tx,
          identity,
          from,
          event.status,
          event.status === ShipmentStatus.FAILED_ATTEMPT
            ? { failedAttempts: { increment: 1 } }
            : {},
          meta
        )
        return CarrierEventOutcomes.APPLIED
      })
    } catch (error) {
      // Two deliveries of one event at the same instant: the index of the history says the second is a twin
      if (isUniqueViolation(error)) return CarrierEventOutcomes.DUPLICATE
      throw error
    }
  }

  private async isTwin(
    storeId: string,
    shipmentId: string,
    event: CarrierStatusEvent,
    tx: PrismaTransaction = this.prisma.client
  ): Promise<boolean> {
    const twin = await tx.shipmentEvent.findFirst({
      where:
        event.providerEventId === undefined
          ? { storeId, shipmentId, status: event.status, occurredAt: event.occurredAt }
          : { storeId, shipmentId, providerEventId: event.providerEventId },
      select: { id: true }
    })
    return twin !== null
  }
}
