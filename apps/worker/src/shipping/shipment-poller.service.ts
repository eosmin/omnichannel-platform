import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  CarrierCapability,
  CarrierConnectionStatus,
  CarrierPolling,
  ShipmentEventSource,
  ShipmentKind,
  ShipmentStatus
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { buildCarrierContext, withDeadline } from '@platform/core/shipping'
import { CarrierRegistry, carrierEventSchema } from '@platform/plugins/runtime'
import type { CarrierEvent, ShipmentRef } from '@platform/plugins/sdk'

import { CarrierEventApplier, CarrierEventHandled } from '../carriers/carrier-event-applier.service'

const DAY_MS = 24 * 60 * 60 * 1000

// The packages that are on their way and may change status (a guide made may be picked up any moment)
export const POLLED_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.LABEL_CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  // On its way back: the carrier says when it arrives
  ShipmentStatus.RETURNING
]

export interface PollReport {
  asked: number
  applied: number
  stored: number
  duplicate: number
  // Events that do not fit the bounds of an event (a status that is not a code, a text too long): not applied
  unreadable: number
  // Events that moved nothing and were kept nowhere: the connection is not active, or the shipment is not ours
  ignored: number
  failed: number
}

// A poll of one connection (TDD_17 §4.9): the carrier is asked about the packages that are on their way, in batches, and each
// answer goes through the same engine as a webhook, so an event that arrives by both ways counts once. Polling stops by itself
// for a shipment that reaches a terminal status (it is no longer asked), and for a connection that was disconnected.
@Injectable()
export class ShipmentPoller {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CarrierRegistry,
    private readonly cipher: CredentialCipher,
    private readonly applier: CarrierEventApplier,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ShipmentPoller.name)
  }

  async poll(
    storeId: string,
    connectionId: string,
    options: { includeOld: boolean; now?: Date }
  ): Promise<PollReport> {
    const report: PollReport = {
      asked: 0,
      applied: 0,
      stored: 0,
      duplicate: 0,
      unreadable: 0,
      ignored: 0,
      failed: 0
    }
    const connection = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: {
        id: true,
        storeId: true,
        carrierId: true,
        status: true,
        credentials: true,
        contact: true
      }
    })
    if (connection === null || connection.status !== String(CarrierConnectionStatus.ACTIVE)) {
      // A connection that was let go is not asked again: dropped and said once
      this.logger.info({ connectionId }, 'a poll for a connection that is not active was dropped')
      return report
    }
    const plugin = this.registry.find(connection.carrierId)
    if (
      plugin?.fetchStatus === undefined ||
      !plugin.capabilities.includes(CarrierCapability.FETCH_STATUS)
    ) {
      return report
    }
    const fetchStatus = plugin.fetchStatus.bind(plugin)
    const now = options.now ?? new Date()
    const oldBefore = new Date(now.getTime() - CarrierPolling.OLD_AFTER_DAYS * DAY_MS)
    let cursor: string | undefined
    for (;;) {
      const shipments = await this.prisma.client.shipment.findMany({
        where: {
          storeId,
          connectionId,
          kind: ShipmentKind.OUTBOUND,
          status: { in: [...POLLED_STATUSES] },
          guideNumber: { not: null },
          ...(options.includeOld ? {} : { createdAt: { gte: oldBefore } })
        },
        select: {
          id: true,
          guideNumber: true,
          providerShipmentId: true,
          order: { select: { orderNumber: true } }
        },
        orderBy: { id: 'asc' },
        take: CarrierPolling.BATCH_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      if (shipments.length === 0) break
      cursor = shipments.at(-1)?.id
      report.asked += shipments.length
      const refs: ShipmentRef[] = shipments.map(shipment => ({
        reference: shipment.order.orderNumber,
        ...(shipment.guideNumber === null ? {} : { guideNumber: shipment.guideNumber }),
        ...(shipment.providerShipmentId === null
          ? {}
          : { providerShipmentId: shipment.providerShipmentId })
      }))
      let events: CarrierEvent[]
      try {
        const context = buildCarrierContext(connection, this.cipher)
        events = await withDeadline(() => fetchStatus(context, refs))
      } catch (error) {
        // The carrier is down or the credentials do not open: the next tick asks again, and nothing was changed
        report.failed += shipments.length
        this.logger.warn(
          { connectionId, errorName: errorName(error) },
          'the carrier could not be polled'
        )
        // A carrier that is down is not asked again for each page: the next tick asks
        break
      }
      await this.applyAll(storeId, connectionId, shipments, events, report)
      if (shipments.length < CarrierPolling.BATCH_SIZE) break
    }
    if (report.unreadable > 0) {
      // A carrier whose events never fit the bounds (a date with no offset, a code too long) would otherwise be polled in silence
      this.logger.warn(
        { connectionId, unreadable: report.unreadable },
        'polled carrier events did not fit the bounds of an event and were not applied'
      )
    }
    return report
  }

  private async applyAll(
    storeId: string,
    connectionId: string,
    shipments: readonly {
      id: string
      guideNumber: string | null
      providerShipmentId: string | null
      order: { orderNumber: string }
    }[],
    events: readonly CarrierEvent[],
    report: PollReport
  ): Promise<void> {
    const byGuide = new Map(
      shipments.flatMap(s => (s.guideNumber === null ? [] : [[s.guideNumber, s.id]]))
    )
    const byProvider = new Map(
      shipments.flatMap(s => (s.providerShipmentId === null ? [] : [[s.providerShipmentId, s.id]]))
    )
    const byOrder = new Map<string, string[]>()
    for (const shipment of shipments) {
      const list = byOrder.get(shipment.order.orderNumber) ?? []
      list.push(shipment.id)
      byOrder.set(shipment.order.orderNumber, list)
    }
    // In the order the carrier lived them: a delivery never comes before the pickup that made it possible
    // An event whose moment is not a moment is not applied (the engine ignores it too), and would break the order of the rest
    const dated = events.filter(event => !Number.isNaN(new Date(event.occurredAt).getTime()))
    const ordered = dated.sort(
      (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
    )
    for (const event of ordered) {
      const shipmentId = this.shipmentOf(event, byGuide, byProvider, byOrder)
      if (shipmentId === null) continue
      // The same checks as a webhook event: bounded, status fields only. The free text of the carrier is not kept
      const valid = carrierEventSchema.safeParse({
        providerEventId: event.providerEventId,
        status: event.status,
        rawStatus: event.rawStatus,
        rawReason: event.rawReason,
        occurredAt: event.occurredAt,
        guideNumber: event.guideNumber,
        providerShipmentId: event.providerShipmentId,
        reference: event.reference
      })
      if (!valid.success) {
        report.unreadable += 1
        continue
      }
      try {
        // Through the mapping of the connection, as a webhook is: a code nobody mapped is kept and announced, not dropped
        const outcome = await this.applier.applyToShipment(
          {
            storeId,
            connectionId,
            event: valid.data,
            receivedAt: new Date().toISOString()
          },
          shipmentId,
          ShipmentEventSource.POLL
        )
        if (outcome === CarrierEventHandled.APPLIED) report.applied += 1
        else if (outcome === CarrierEventHandled.DUPLICATE) report.duplicate += 1
        else if (outcome === CarrierEventHandled.STORED) report.stored += 1
        else report.ignored += 1
      } catch (error) {
        report.failed += 1
        this.logger.warn(
          { shipmentId, errorName: errorName(error) },
          'a polled event could not be applied'
        )
      }
    }
  }

  // Which of the asked shipments an event is about: its guide, then the carrier's id, then the order number when it names one
  // shipment only (an order split between warehouses has several under one number, and a loose match is not a match)
  private shipmentOf(
    event: CarrierEvent,
    byGuide: ReadonlyMap<string, string>,
    byProvider: ReadonlyMap<string, string>,
    byOrder: ReadonlyMap<string, string[]>
  ): string | null {
    const byGuideNumber =
      event.guideNumber === undefined ? undefined : byGuide.get(event.guideNumber)
    if (byGuideNumber !== undefined) return byGuideNumber
    const byCarrierId =
      event.providerShipmentId === undefined ? undefined : byProvider.get(event.providerShipmentId)
    if (byCarrierId !== undefined) return byCarrierId
    // A guide or an id that names none of the asked packages is not ours; only an event that names neither falls back to the
    // order number
    if (event.guideNumber !== undefined || event.providerShipmentId !== undefined) return null
    if (event.reference !== undefined) {
      const candidates = byOrder.get(event.reference) ?? []
      return candidates.length === 1 ? (candidates[0] ?? null) : null
    }
    return null
  }
}
