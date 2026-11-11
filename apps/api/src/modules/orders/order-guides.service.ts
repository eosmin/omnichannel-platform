import { Injectable } from '@nestjs/common'

import type { PrismaTransaction } from '@platform/core/database'
import {
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentPastPickupStatuses,
  type ShipmentStatus
} from '@platform/core/domain'
import type { ActorRef } from '@platform/core/events'
import { ShipmentCancellation, type VoidJob } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { ShipmentVoidQueue } from '../shipments/shipment-void-queue.service'

export interface VoidedGuides {
  // The guides whose void was started, for the audit entry of the order
  shipmentIds: string[]
  // The ones the carrier has to be asked about: queued once the transaction of the order has committed
  jobs: VoidJob[]
}

// What the order does to the guides it holds (TDD_17 §4.8): cancelling the order, or editing what a guide was made from, voids
// the guides that are still only a label. It runs inside the transaction of the order (which holds the store and order locks),
// so the order and its guides change together or not at all, and queues the carrier calls after the commit.
@Injectable()
export class OrderGuides {
  constructor(
    private readonly cancellation: ShipmentCancellation,
    private readonly queue: ShipmentVoidQueue,
    private readonly registry: CarrierRegistry
  ) {}

  private readonly plugins = (carrierId: string) => this.registry.find(carrierId)

  // A guide whose outcome is unknown, or whose package has left, refuses (the shipment's own rule): the order is not changed. One
  // that is already being voided (or failed to be) is left as it is. A `local` guide is voided at once.
  async voidLive(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    actor: ActorRef,
    // An edit of a package that already left has no guide to void and is not refused for it (its address is still editable);
    // cancelling the order is refused
    options: { leftPackages: 'refuse' | 'ignore' } = { leftPackages: 'refuse' }
  ): Promise<VoidedGuides> {
    const live = await tx.shipment.findMany({
      where: {
        orderId,
        storeId,
        kind: ShipmentKind.OUTBOUND,
        status: { notIn: [...ShipmentInactiveStatuses] }
      },
      select: { id: true, status: true },
      orderBy: { id: 'asc' }
    })
    const voided: VoidedGuides = { shipmentIds: [], jobs: [] }
    for (const { id, status } of live) {
      if (
        options.leftPackages === 'ignore' &&
        ShipmentPastPickupStatuses.includes(status as ShipmentStatus)
      ) {
        continue
      }
      const started = await this.cancellation.start(tx, storeId, id, actor, this.plugins, {
        refusePending: false
      })
      if (started.change.from !== started.change.to || started.job !== null) {
        voided.shipmentIds.push(id)
      }
      if (started.job !== null) voided.jobs.push(started.job)
    }
    return voided
  }

  async hand(storeId: string, voided: VoidedGuides, requestedBy: string | null): Promise<void> {
    await this.queue.enqueue(storeId, voided.jobs, requestedBy)
  }
}
