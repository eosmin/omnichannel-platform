import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import {
  lockStoreForWrite,
  lockStoreScope,
  type PrismaTransaction,
  PrismaService
} from '@platform/core/database'
import {
  CarrierCapability,
  CarrierConnectionStatus,
  CarrierEventOutcomes,
  CarrierWebhookTrust,
  providerStatusCodeOf,
  ShipmentEventSource,
  ShipmentKind,
  ShipmentLockScopes,
  ShipmentStatus
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { type ActorRef, Events } from '@platform/core/events'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  buildCarrierContext,
  clampCarrierMessage,
  findShipmentOfEvent,
  recordUnmappedStatus,
  ShipmentLookupKinds,
  ShipmentStatusEngine,
  ShipmentWrites,
  StatusResolutionKinds,
  withDeadline
} from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'
import type { ProcessCarrierEventJob } from '@platform/plugins/runtime'

import { CarrierEventResolver } from './carrier-event-resolver.service'

type Event = ProcessCarrierEventJob['event']

// The closing statuses a carrier that only shares a secret must confirm before they are applied (TDD_17 §4.9): they close money
// or the order
const CONFIRMED_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNED
]

export const CarrierEventHandled = {
  // The same words the engine uses, plus the two ways this layer ends an event with no change at all
  ...CarrierEventOutcomes,
  // The carrier said something that does not hold: a closing status its own answer does not back
  UNCONFIRMED: 'unconfirmed'
} as const
export type CarrierEventHandledType = (typeof CarrierEventHandled)[keyof typeof CarrierEventHandled]

// What a webhook (or a poll) of a carrier does to a shipment (TDD_17 §4.9, §4.17): the event is read for its connection, the
// shipment it names is found inside that connection, and then one of three things happens. A status the platform applies goes
// through the engine (the table, the dedupe, the order of arrival). A status the owner chose to ignore, or one nobody mapped,
// is kept in the history with no status, and the unmapped one is also recorded in the list the owner reads and announced
// ONCE: the line, the record and the announcement are one transaction, so a job that is tried again finds the line and does
// nothing, and the first sighting can neither be lost nor told twice. A carrier that proves its webhook with a shared secret
// only is asked before a delivery or a return is believed.
@Injectable()
export class CarrierEventApplier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: CarrierEventResolver,
    private readonly engine: ShipmentStatusEngine,
    private readonly writes: ShipmentWrites,
    private readonly events: DomainEvents,
    private readonly registry: CarrierRegistry,
    private readonly cipher: CredentialCipher,
    @InjectMetric(MetricNames.SHIPMENT_UNKNOWN_STATUS_TOTAL)
    private readonly unknownStatus: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(CarrierEventApplier.name)
  }

  // An event that names its shipment only by what the carrier calls it (a webhook): the shipment is found inside the connection
  async apply(
    job: ProcessCarrierEventJob,
    source: typeof ShipmentEventSource.WEBHOOK | typeof ShipmentEventSource.POLL
  ): Promise<CarrierEventHandledType> {
    const { storeId, connectionId, event } = job
    const lookup = await findShipmentOfEvent(
      this.prisma.client,
      { storeId, connectionId },
      {
        providerShipmentId: event.providerShipmentId,
        guideNumber: event.guideNumber,
        reference: event.reference
      }
    )
    if (lookup.kind !== ShipmentLookupKinds.FOUND) {
      // Nothing of this connection answers to it (or two things do): kept nowhere, because a history line needs its shipment.
      // The carrier may tell it again once the guide is stored.
      this.logger.warn({ connectionId, lookup: lookup.kind }, 'a carrier event names no shipment')
      return CarrierEventHandled.IGNORED
    }
    return this.applyToShipment(job, lookup.shipmentId, source)
  }

  // An event whose shipment is already known (a poll asked about it): read for its connection, then moved, or kept when nobody
  // has said what its code means
  async applyToShipment(
    job: ProcessCarrierEventJob,
    shipmentId: string,
    source: typeof ShipmentEventSource.WEBHOOK | typeof ShipmentEventSource.POLL
  ): Promise<CarrierEventHandledType> {
    const { storeId, event } = job
    const meaning = await this.resolver.resolve(job)
    if (meaning === null) return CarrierEventHandled.IGNORED
    const { resolution } = meaning
    const occurredAt = new Date(event.occurredAt)

    if (resolution.kind === StatusResolutionKinds.MAPPED) {
      if (!(await this.confirmed(job, meaning.carrierId, shipmentId, resolution.status))) {
        return CarrierEventHandled.UNCONFIRMED
      }
      return this.engine.apply(
        storeId,
        shipmentId,
        {
          status: resolution.status,
          rawStatus: textOf(event),
          occurredAt,
          ...(event.providerEventId === undefined ? {} : { providerEventId: event.providerEventId })
        },
        source
      )
    }
    return this.keep(job, shipmentId, occurredAt, resolution, source, meaning.carrierId)
  }

  // A closing status from a carrier that shares a secret instead of signing: the carrier is asked, and the event is applied only
  // if its own answer says the same. A carrier that cannot be reached fails the job (BullMQ asks again); one that says
  // something else drops it, and says so in the log.
  async confirmed(
    job: Pick<ProcessCarrierEventJob, 'storeId' | 'connectionId'>,
    carrierId: string,
    shipmentId: string,
    status: ShipmentStatus
  ): Promise<boolean> {
    const plugin = this.registry.find(carrierId)
    if (plugin?.webhookTrust !== CarrierWebhookTrust.SHARED_SECRET) return true
    if (!CONFIRMED_STATUSES.includes(status)) return true
    const { storeId, connectionId } = job
    if (
      plugin.fetchStatus === undefined ||
      !this.registry.hasCapability(carrierId, CarrierCapability.FETCH_STATUS)
    ) {
      // The registry refuses such a plugin; if it ever happens, nothing closes on an unchecked word
      this.logger.error({ connectionId }, 'a shared-secret carrier cannot be asked: event dropped')
      return false
    }
    const connection = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId, status: String(CarrierConnectionStatus.ACTIVE) },
      select: { id: true, storeId: true, credentials: true, contact: true }
    })
    const shipment = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId, storeId, kind: ShipmentKind.OUTBOUND },
      select: {
        guideNumber: true,
        providerShipmentId: true,
        order: { select: { orderNumber: true } }
      }
    })
    if (connection === null || shipment === null) return false
    const ctx = buildCarrierContext(connection, this.cipher)
    const asked = await withDeadline(
      () =>
        plugin.fetchStatus?.(ctx, [
          {
            reference: shipment.order.orderNumber,
            ...(shipment.guideNumber === null ? {} : { guideNumber: shipment.guideNumber }),
            ...(shipment.providerShipmentId === null
              ? {}
              : { providerShipmentId: shipment.providerShipmentId })
          }
        ]) ?? Promise.resolve([])
    )
    for (const answer of asked) {
      // Each answer is read as any event of this connection is: by the mapping first, the plugin's status second
      const meaning = await this.resolver.resolve({
        storeId,
        connectionId,
        receivedAt: new Date().toISOString(),
        event: {
          status: answer.status,
          rawStatus: answer.rawStatus,
          ...(answer.rawReason === undefined ? {} : { rawReason: answer.rawReason }),
          occurredAt: answer.occurredAt
        }
      })
      if (
        meaning?.resolution.kind === StatusResolutionKinds.MAPPED &&
        meaning.resolution.status === status
      ) {
        return true
      }
    }
    this.logger.warn(
      { connectionId, claimed: status },
      'a carrier event was not confirmed by the carrier: dropped as suspicious'
    )
    return false
  }

  // A status that moves nothing: ignored on purpose, or nobody has said what it means. The history line, the record of the code
  // and the announcement of its first sighting are one transaction.
  private async keep(
    job: ProcessCarrierEventJob,
    shipmentId: string,
    occurredAt: Date,
    resolution: { kind: string; code: string },
    source: typeof ShipmentEventSource.WEBHOOK | typeof ShipmentEventSource.POLL,
    carrierId: string
  ): Promise<CarrierEventHandledType> {
    const { storeId, connectionId, event } = job
    if (Number.isNaN(occurredAt.getTime())) return CarrierEventHandled.IGNORED
    const unmapped = resolution.kind === StatusResolutionKinds.UNMAPPED
    const plainCode = providerStatusCodeOf(event.rawStatus)
    const reasonCode =
      event.rawReason === undefined ? undefined : providerStatusCodeOf(event.rawReason)
    const text = textOf(event)
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const known = await tx.shipment.findFirst({
        where: { id: shipmentId, storeId, kind: ShipmentKind.OUTBOUND },
        select: { orderId: true }
      })
      if (known === null) return CarrierEventHandled.IGNORED
      await lockStoreScope(tx, storeId, `${ShipmentLockScopes.ORDER}:${known.orderId}`)
      const row = await this.liveShipment(tx, storeId, shipmentId)
      if (row === null) return CarrierEventHandled.IGNORED
      // The same event again: by its id, or by its words and moment when the carrier sends no id
      const twin = await tx.shipmentEvent.findFirst({
        where:
          event.providerEventId === undefined
            ? { storeId, shipmentId, status: null, rawStatus: text, occurredAt }
            : { storeId, shipmentId, providerEventId: event.providerEventId },
        select: { id: true }
      })
      if (twin !== null) return CarrierEventHandled.DUPLICATE
      const actor: ActorRef = { type: 'system', id: null }
      await this.writes.recordHistory(
        tx,
        {
          shipmentId: row.id,
          storeId: row.storeId,
          orderId: row.orderId,
          orderNumber: row.order.orderNumber,
          connectionId: row.connectionId
        },
        null,
        {
          actor,
          source,
          occurredAt,
          rawStatus: text,
          ...(event.providerEventId === undefined
            ? {}
            : { providerEventId: event.providerEventId }),
          // What a replay needs to give the line its meaning later: the normalized parts of the code
          payload: {
            providerCode: resolution.code,
            plainCode,
            ...(reasonCode === undefined ? {} : { reasonCode })
          }
        }
      )
      if (!unmapped) return CarrierEventHandled.STORED
      const recorded = await recordUnmappedStatus(tx, {
        storeId,
        connectionId,
        providerCode: resolution.code,
        rawStatus: text
      })
      if (!recorded.recorded) {
        this.logger.warn({ connectionId, carrierId }, 'an unmapped carrier status was not recorded')
      }
      if (recorded.firstSighting) {
        // Published inside the transaction: the bus announces it once the transaction commits, and not at all if it rolls back
        this.events.publish(tx, Events.CARRIER_STATUS_UNMAPPED, {
          storeId,
          connectionId,
          providerCode: resolution.code
        })
      }
      return CarrierEventHandled.STORED
    })
    if (unmapped && outcome === CarrierEventHandled.STORED) {
      this.unknownStatus.inc({ carrier: carrierId })
    }
    return outcome
  }

  private liveShipment(tx: PrismaTransaction, storeId: string, shipmentId: string) {
    return tx.shipment.findFirst({
      where: {
        id: shipmentId,
        storeId,
        connection: { status: String(CarrierConnectionStatus.ACTIVE) }
      },
      select: {
        id: true,
        storeId: true,
        orderId: true,
        connectionId: true,
        order: { select: { orderNumber: true } }
      }
    })
  }
}

// What the carrier called the status, as one line, with the reason when it sent one (a composite code is how it is mapped)
function textOf(event: Event): string {
  const text =
    event.rawReason === undefined ? event.rawStatus : `${event.rawStatus}:${event.rawReason}`
  return clampCarrierMessage(text)
}
