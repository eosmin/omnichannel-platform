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
  PickupDefaults,
  PickupLimits,
  PickupLockScopes,
  PickupManualReasons,
  PickupOpenStatuses,
  PickupStatus,
  type PickupWaitReason,
  PickupWaitReasons,
  ShipmentInactiveStatuses,
  ShipmentKind
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { type ActorRef, Events } from '@platform/core/events'
import { ShipmentCreationModes } from '@platform/plugins/sdk'

import { withDeadline } from './carrier-call'
import { buildCarrierContext } from './carrier-context'
import {
  decideJoin,
  isPickupCutoffPassed,
  PickupEligibleStatuses,
  resolvePickupDate
} from './pickup-rules'
import type { PluginLookup } from './shipment-prepare'
import { ShipmentWrites } from './shipment-writes'

export interface EnsurePickupInput {
  connectionId: string
  // The guides to put in the pickup; without them, every guide of the connection that is waiting
  shipmentIds?: readonly string[] | undefined
  // 'YYYY-MM-DD'; without it the next day the connection takes pickups
  date?: string | undefined
  // A person confirmed the change of a pickup of today after its cutoff
  confirmAfterCutoff?: boolean | undefined
  actor: ActorRef
  now?: Date | undefined
}

export interface PickupWait {
  shipmentId: string
  reason: PickupWaitReason
}

export interface EnsurePickupResult {
  // null when there was nothing to collect
  pickupId: string | null
  created: boolean
  joined: readonly string[]
  waiting: readonly PickupWait[]
  // The carrier has to be asked or told the new count: the caller queues the sync once this has committed
  sync: boolean
  revision: number
}

export interface PickupChange {
  pickupId: string
  sync: boolean
  revision: number
}

const noEligible = (): PlatformException =>
  new PlatformException(
    ErrorCodes.PICKUP_SHIPMENT_NOT_ELIGIBLE,
    'a shipment is not a guide waiting for a pickup of this connection',
    HttpStatusCodes.CONFLICT
  )

const notEditable = (message: string): PlatformException =>
  new PlatformException(ErrorCodes.PICKUP_NOT_EDITABLE, message, HttpStatusCodes.CONFLICT)

const dayOf = (date: Date): string => date.toISOString().slice(0, 10)

// The pickups of a connection (TDD_17 §4.10). A standalone carrier has at most one open pickup per connection and day: this
// service is the only place a pickup is made or joined, it takes the lock of the connection first, and the scheduler and the
// agent both come through `ensurePickup`, so a request racing the scheduler ends with one pickup. It never calls a carrier in a
// transaction: a pickup is made PENDING and the caller queues `SYNC_PICKUP` once the transaction has committed (`PickupSync`).
@Injectable()
export class PickupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly writes: ShipmentWrites,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PickupsService.name)
  }

  async ensurePickup(
    storeId: string,
    input: EnsurePickupInput,
    plugins: PluginLookup
  ): Promise<EnsurePickupResult> {
    const now = input.now ?? new Date()
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, `${PickupLockScopes.CONNECTION}:${input.connectionId}`)
      const connection = await this.activeConnection(tx, storeId, input.connectionId)
      const plugin = plugins(connection.carrierId)
      if (plugin === undefined) {
        throw new PlatformException(
          ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
          'the carrier is not available',
          HttpStatusCodes.CONFLICT
        )
      }
      // A carrier that makes its pickup with its guides has no pickup of its own to ask for (TDD_17 §4.5)
      if (
        !connection.pickupEnabled ||
        plugin.shipmentCreation === ShipmentCreationModes.PICKUP_BOUND
      ) {
        throw new PlatformException(
          ErrorCodes.PICKUP_NOT_ENABLED,
          'this connection does not take pickups through the platform',
          HttpStatusCodes.CONFLICT
        )
      }
      const store = await tx.store.findFirst({ where: { id: storeId }, select: { timezone: true } })
      if (store === null) throw resourceNotFound('store')
      const rules = {
        pickupDays: connection.pickupDays,
        pickupCutoffTime: connection.pickupCutoffTime
      }
      const day = resolvePickupDate(now, store.timezone, rules, input.date)
      if ('refusal' in day) {
        throw day.refusal === 'no_days'
          ? new PlatformException(
              ErrorCodes.PICKUP_NOT_ENABLED,
              'the connection has no pickup days',
              HttpStatusCodes.CONFLICT
            )
          : new PlatformException(
              ErrorCodes.VALIDATION_INVALID_INPUT,
              day.refusal === 'in_the_past'
                ? 'the pickup day is over'
                : 'the connection does not take pickups that day',
              HttpStatusCodes.BAD_REQUEST
            )
      }
      const eligible = await this.eligibleShipments(tx, storeId, input)
      const open = await tx.pickupRequest.findFirst({
        where: {
          storeId,
          connectionId: input.connectionId,
          pickupDate: new Date(`${day.date}T00:00:00.000Z`),
          status: { in: [...PickupOpenStatuses] }
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
      if (open === null) {
        return eligible.length === 0
          ? { pickupId: null, created: false, joined: [], waiting: [], sync: false, revision: 0 }
          : this.createPickup(tx, storeId, input, day.date, eligible, plugin)
      }
      const cutoffPassed = isPickupCutoffPassed(
        now,
        store.timezone,
        dayOf(open.pickupDate),
        connection.pickupCutoffTime
      )
      const decision = decideJoin({
        status: open.status as PickupStatus,
        providerPickupId: open.providerPickupId,
        canModify:
          plugin.capabilities.includes(CarrierCapability.PICKUP_MODIFY) &&
          plugin.modifyPickup !== undefined,
        cutoffPassed,
        confirmedAfterCutoff: input.confirmAfterCutoff === true
      })
      if (decision.kind === 'cutoff' && input.actor.type === 'user') {
        throw new PlatformException(
          ErrorCodes.PICKUP_CUTOFF_PASSED,
          'the cutoff of this pickup has passed',
          HttpStatusCodes.CONFLICT
        )
      }
      if (decision.kind !== 'join') {
        const reason = decision.kind === 'wait' ? decision.reason : PickupWaitReasons.CUTOFF_PASSED
        return {
          pickupId: open.id,
          created: false,
          joined: [],
          waiting: eligible.map(shipment => ({ shipmentId: shipment.id, reason })),
          sync: false,
          revision: open.revision
        }
      }
      if (eligible.length === 0) {
        return {
          pickupId: open.id,
          created: false,
          joined: [],
          waiting: [],
          sync: false,
          revision: open.revision
        }
      }
      await tx.shipment.updateMany({
        where: { id: { in: eligible.map(shipment => shipment.id) }, storeId },
        data: { pickupId: open.id }
      })
      const count = await this.heldCount(tx, storeId, open.id)
      const updated = await tx.pickupRequest.update({
        where: { id: open.id },
        data: {
          packageCount: count,
          ...(decision.tellCarrier ? { revision: { increment: 1 } } : {})
        }
      })
      return {
        pickupId: open.id,
        created: false,
        joined: eligible.map(shipment => shipment.id),
        waiting: [],
        sync: decision.tellCarrier,
        revision: updated.revision
      }
    })
  }

  // The agent takes a guide out of a pickup (TDD_17 §4.10, §6). The last guide of a pickup the carrier holds is not taken out:
  // the pickup is cancelled instead.
  async removeShipment(
    storeId: string,
    pickupId: string,
    shipmentId: string
  ): Promise<PickupChange> {
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const pickup = await this.pickupOf(tx, storeId, pickupId)
      await lockStoreScope(tx, storeId, `${PickupLockScopes.CONNECTION}:${pickup.connectionId}`)
      const status = pickup.status as PickupStatus
      const editable =
        status === PickupStatus.PENDING ||
        status === PickupStatus.MANUAL_REQUIRED ||
        status === PickupStatus.REQUESTED ||
        status === PickupStatus.CONFIRMED
      if (!editable) throw notEditable('the pickup cannot change in its current state')
      const held = await tx.shipment.findFirst({
        where: { id: shipmentId, storeId, pickupId },
        select: { id: true }
      })
      if (held === null) throw resourceNotFound('shipment')
      const remaining = await tx.shipment.aggregate({
        _sum: { packageCount: true },
        where: {
          storeId,
          pickupId,
          id: { not: shipmentId },
          status: { notIn: [...ShipmentInactiveStatuses] }
        }
      })
      const count = remaining._sum.packageCount ?? 0
      if (count === 0 && status !== PickupStatus.MANUAL_REQUIRED) {
        throw notEditable('the last shipment of a pickup leaves by cancelling the pickup')
      }
      await tx.shipment.updateMany({ where: { id: shipmentId, storeId }, data: { pickupId: null } })
      const carrierHolds = status === PickupStatus.REQUESTED || status === PickupStatus.CONFIRMED
      await tx.pickupRequest.update({
        where: { id: pickupId },
        data: { packageCount: count, ...(carrierHolds ? { revision: { increment: 1 } } : {}) }
      })
      if (count === 0) {
        await this.writes.movePickup(tx, storeId, pickupId, status, PickupStatus.CANCELLED, {})
      }
      const revision = await this.revisionOf(tx, storeId, pickupId)
      return { pickupId, sync: carrierHolds, revision }
    })
  }

  // "Mark as confirmed": the agent agreed the pickup with the courier (a manual one), or saw the carrier confirm it
  async confirm(storeId: string, pickupId: string): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const pickup = await this.pickupOf(tx, storeId, pickupId)
      const status = pickup.status as PickupStatus
      if (status !== PickupStatus.MANUAL_REQUIRED && status !== PickupStatus.REQUESTED) {
        throw notEditable('only a pickup that waits for the courier can be confirmed')
      }
      await this.writes.movePickup(tx, storeId, pickupId, status, PickupStatus.CONFIRMED, {
        lastError: null
      })
    })
  }

  // Cancelling a pickup the carrier holds asks the carrier first: a pickup is never shown as cancelled while the carrier still
  // sends a courier. A pickup that is still being asked (PENDING) has nothing to cancel yet. The guides go back to waiting.
  async cancel(storeId: string, pickupId: string, plugins: PluginLookup): Promise<void> {
    const pickup = await this.prisma.client.pickupRequest.findFirst({
      where: { id: pickupId, storeId }
    })
    if (pickup === null) throw resourceNotFound('pickup')
    const status = pickup.status as PickupStatus
    if (status === PickupStatus.REQUESTED || status === PickupStatus.CONFIRMED) {
      await this.cancelAtCarrier(storeId, pickup, plugins)
    }
    await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const current = await this.pickupOf(tx, storeId, pickupId)
      const from = current.status as PickupStatus
      // A pickup whose outcome nobody knows ends as failed (the carrier's side is settled by the agent there); the others as cancelled
      const to =
        from === PickupStatus.REQUIRES_REVIEW ? PickupStatus.FAILED : PickupStatus.CANCELLED
      if (from === PickupStatus.PENDING) {
        throw notEditable('the carrier is being asked for this pickup: wait for the answer')
      }
      if (!PickupOpenStatuses.includes(from)) throw notEditable('the pickup is over')
      await this.writes.movePickup(tx, storeId, pickupId, from, to, {})
      await tx.shipment.updateMany({ where: { storeId, pickupId }, data: { pickupId: null } })
    })
  }

  // The manifest the agent prints for the courier (TDD_17 §4.10): guide, recipient and packages of what the pickup holds
  async manifest(storeId: string, pickupId: string): Promise<PickupManifest> {
    const pickup = await this.prisma.client.pickupRequest.findFirst({
      where: { id: pickupId, storeId },
      select: {
        id: true,
        pickupDate: true,
        status: true,
        packageCount: true,
        windowStart: true,
        windowEnd: true,
        connection: { select: { displayName: true } },
        shipments: {
          where: { status: { notIn: [...ShipmentInactiveStatuses] } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            guideNumber: true,
            packageCount: true,
            order: { select: { orderNumber: true, customer: { select: { name: true } } } }
          }
        }
      }
    })
    if (pickup === null) throw resourceNotFound('pickup')
    return {
      pickupId: pickup.id,
      connectionName: pickup.connection.displayName,
      pickupDate: dayOf(pickup.pickupDate),
      status: pickup.status as PickupStatus,
      packageCount: pickup.packageCount,
      windowStart: pickup.windowStart,
      windowEnd: pickup.windowEnd,
      lines: pickup.shipments.map(shipment => ({
        shipmentId: shipment.id,
        guideNumber: shipment.guideNumber,
        recipient: shipment.order.customer.name?.trim() || shipment.order.orderNumber,
        orderNumber: shipment.order.orderNumber,
        packageCount: shipment.packageCount
      }))
    }
  }

  // ---------------------------------------------------------------------------------------------------------- helpers

  private async createPickup(
    tx: PrismaTransaction,
    storeId: string,
    input: EnsurePickupInput,
    date: string,
    eligible: readonly { id: string; packageCount: number }[],
    plugin: { capabilities: readonly string[]; requestPickup?: unknown }
  ): Promise<EnsurePickupResult> {
    const canRequest =
      plugin.capabilities.includes(CarrierCapability.PICKUP_REQUEST) &&
      plugin.requestPickup !== undefined
    const count = eligible.reduce((sum, shipment) => sum + shipment.packageCount, 0)
    const pickup = await tx.pickupRequest.create({
      data: {
        storeId,
        connectionId: input.connectionId,
        pickupDate: new Date(`${date}T00:00:00.000Z`),
        status: canRequest ? PickupStatus.PENDING : PickupStatus.MANUAL_REQUIRED,
        packageCount: count,
        windowStart: PickupDefaults.WINDOW_FROM,
        windowEnd: PickupDefaults.WINDOW_TO,
        requestedBy: input.actor.id ?? 'system'
      }
    })
    await tx.shipment.updateMany({
      where: { id: { in: eligible.map(shipment => shipment.id) }, storeId },
      data: { pickupId: pickup.id }
    })
    if (!canRequest) {
      this.events.publish(tx, Events.PICKUP_MANUAL_REQUIRED, {
        storeId,
        pickupId: pickup.id,
        connectionId: input.connectionId,
        pickupDate: date,
        packageCount: count,
        reason: PickupManualReasons.NO_API
      })
    }
    return {
      pickupId: pickup.id,
      created: true,
      joined: eligible.map(shipment => shipment.id),
      waiting: [],
      sync: canRequest,
      revision: pickup.revision
    }
  }

  private async activeConnection(tx: PrismaTransaction, storeId: string, connectionId: string) {
    const connection = await tx.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: {
        id: true,
        carrierId: true,
        status: true,
        pickupEnabled: true,
        pickupDays: true,
        pickupCutoffTime: true
      }
    })
    if (connection === null) throw resourceNotFound('carrier')
    if (connection.status !== String(CarrierConnectionStatus.ACTIVE)) {
      throw new PlatformException(
        ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
        'the carrier is not active',
        HttpStatusCodes.CONFLICT
      )
    }
    return connection
  }

  // The guides that may join: still only a label, with no pickup, outbound, of this connection. Guides that were named and are not
  // eligible refuse the whole request (a pickup is never made from part of what was asked).
  private async eligibleShipments(
    tx: PrismaTransaction,
    storeId: string,
    input: EnsurePickupInput
  ): Promise<{ id: string; packageCount: number }[]> {
    const named = input.shipmentIds
    const rows = await tx.shipment.findMany({
      where: {
        storeId,
        connectionId: input.connectionId,
        kind: ShipmentKind.OUTBOUND,
        status: { in: [...PickupEligibleStatuses] },
        pickupId: null,
        guideNumber: { not: null },
        ...(named === undefined ? {} : { id: { in: [...named] } })
      },
      select: { id: true, packageCount: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PickupLimits.MAX_SHIPMENTS
    })
    if (named !== undefined && rows.length !== named.length) throw noEligible()
    return rows
  }

  private async heldCount(
    tx: PrismaTransaction,
    storeId: string,
    pickupId: string
  ): Promise<number> {
    const held = await tx.shipment.aggregate({
      _sum: { packageCount: true },
      where: { storeId, pickupId, status: { notIn: [...ShipmentInactiveStatuses] } }
    })
    return held._sum.packageCount ?? 0
  }

  private async revisionOf(
    tx: PrismaTransaction,
    storeId: string,
    pickupId: string
  ): Promise<number> {
    const row = await tx.pickupRequest.findFirst({
      where: { id: pickupId, storeId },
      select: { revision: true }
    })
    return row?.revision ?? 0
  }

  private async pickupOf(tx: PrismaTransaction, storeId: string, pickupId: string) {
    const pickup = await tx.pickupRequest.findFirst({ where: { id: pickupId, storeId } })
    if (pickup === null) throw resourceNotFound('pickup')
    return pickup
  }

  private async cancelAtCarrier(
    storeId: string,
    pickup: { id: string; connectionId: string; providerPickupId: string | null },
    plugins: PluginLookup
  ): Promise<void> {
    const connection = await this.prisma.client.carrierConnection.findFirst({
      where: { id: pickup.connectionId, storeId },
      select: { id: true, carrierId: true, status: true, credentials: true, contact: true }
    })
    const plugin = connection === null ? undefined : plugins(connection.carrierId)
    if (
      connection === null ||
      plugin?.cancelPickup === undefined ||
      !plugin.capabilities.includes(CarrierCapability.PICKUP_CANCEL) ||
      pickup.providerPickupId === null ||
      connection.status !== String(CarrierConnectionStatus.ACTIVE)
    ) {
      throw notEditable('the carrier of this pickup cannot cancel it: cancel it with the carrier')
    }
    const cancelPickup = plugin.cancelPickup.bind(plugin)
    const context = buildCarrierContext(
      {
        id: connection.id,
        storeId,
        credentials: connection.credentials,
        contact: connection.contact
      },
      this.cipher
    )
    const pickupRef = pickup.providerPickupId
    try {
      await withDeadline(() => cancelPickup(context, { pickupRef }))
    } catch (error) {
      this.logger.warn(
        { pickupId: pickup.id, err: String(error) },
        'a pickup could not be cancelled at the carrier'
      )
      throw new PlatformException(
        ErrorCodes.SHIPPING_CARRIER_UNAVAILABLE,
        'the carrier did not cancel the pickup',
        HttpStatusCodes.SERVICE_UNAVAILABLE
      )
    }
  }
}

export interface PickupManifestLine {
  shipmentId: string
  guideNumber: string | null
  recipient: string
  orderNumber: string
  packageCount: number
}

export interface PickupManifest {
  pickupId: string
  connectionName: string
  pickupDate: string
  status: PickupStatus
  packageCount: number
  windowStart: string | null
  windowEnd: string | null
  lines: readonly PickupManifestLine[]
}
