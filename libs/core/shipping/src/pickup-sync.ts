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
  PickupFailureNotes,
  PickupLeaveNotes,
  PickupLockScopes,
  PickupManualReasons,
  PickupStatus,
  pickupRequestKey
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError
} from '@platform/plugins/sdk'

import { withDeadline } from './carrier-call'
import { buildCarrierContext, CarrierCredentialsUnreadableError } from './carrier-context'
import { pickupNeedsSync } from './pickup-rules'
import type { PluginLookup } from './shipment-prepare'
import { clampCarrierMessage } from './shipment-rules'
import { ShipmentWrites } from './shipment-writes'

export const PickupSyncOutcomes = { DONE: 'done', RETRY: 'retry' } as const
// Inside a run: the carrier took a new count, so the pickup is read again (a change may have landed while it was told)
const MODIFIED = 'modified'
export type PickupSyncOutcome = (typeof PickupSyncOutcomes)[keyof typeof PickupSyncOutcomes]

// A change that lands while the carrier is being told is told again at once, a few times; the sweep of the scheduler catches the rest
const MAX_FOLLOW_UPS = 3
// A reference of a pickup as the carrier gave it: one line of a sane length
const MAX_PICKUP_REF_LENGTH = 200

// The carrier is asked for a pickup, or told the count it holds is out of date (TDD_17 §4.10): the call of the worker, never of a
// request. The pickup row says which. A carrier that does not answer is asked again by the queue with the same key, and the last
// attempt ends the pickup as FAILED, gives its guides back to the waiting list and tells the team. A refusal or credentials that
// do not open end it at once; an answer the platform cannot read leaves it REQUIRES_REVIEW (a pickup may exist).
@Injectable()
export class PickupSync {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly writes: ShipmentWrites,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PickupSync.name)
  }

  async run(
    storeId: string,
    pickupId: string,
    plugins: PluginLookup,
    lastAttempt: boolean
  ): Promise<PickupSyncOutcome> {
    for (let round = 0; round <= MAX_FOLLOW_UPS; round += 1) {
      const pickup = await this.prisma.client.pickupRequest.findFirst({
        where: { id: pickupId, storeId },
        include: {
          connection: {
            select: { id: true, carrierId: true, status: true, credentials: true, contact: true }
          }
        }
      })
      if (pickup === null) return PickupSyncOutcomes.DONE
      const status = pickup.status as PickupStatus
      if (status === PickupStatus.PENDING) {
        const outcome = await this.request(storeId, pickup, plugins, lastAttempt)
        if (outcome !== PickupSyncOutcomes.DONE) return outcome
        continue
      }
      if (
        !pickupNeedsSync({
          status,
          providerPickupId: pickup.providerPickupId,
          packageCount: pickup.packageCount,
          carrierPackageCount: pickup.carrierPackageCount
        }) ||
        pickup.packageCount === 0
      ) {
        return PickupSyncOutcomes.DONE
      }
      const outcome = await this.modify(storeId, pickup, plugins, lastAttempt)
      // Only a count the carrier took asks for another look: a note, a refusal or a carrier that cannot change it end the job
      if (outcome !== MODIFIED) return outcome
    }
    return PickupSyncOutcomes.DONE
  }

  // ------------------------------------------------------------------------------------------------------------ request

  private async request(
    storeId: string,
    pickup: PickupRow,
    plugins: PluginLookup,
    lastAttempt: boolean
  ): Promise<PickupSyncOutcome> {
    const plugin = plugins(pickup.connection.carrierId)
    // Every guide left before the carrier was asked: there is nothing to collect, and the carrier is not asked for an empty pickup
    if (pickup.packageCount === 0) {
      await this.end(storeId, pickup, PickupStatus.FAILED, PickupFailureNotes.EMPTY, false)
      return PickupSyncOutcomes.DONE
    }
    if (pickup.connection.status !== String(CarrierConnectionStatus.ACTIVE)) {
      await this.end(storeId, pickup, PickupStatus.FAILED, PickupFailureNotes.CONNECTION_LOST)
      return PickupSyncOutcomes.DONE
    }
    if (
      plugin?.requestPickup === undefined ||
      !plugin.capabilities.includes(CarrierCapability.PICKUP_REQUEST)
    ) {
      // The carrier lost the way to ask: a person arranges it
      await this.prisma.transaction(async tx => {
        await this.lock(tx, storeId, pickup.connectionId)
        await this.writes.movePickup(
          tx,
          storeId,
          pickup.id,
          PickupStatus.PENDING,
          PickupStatus.MANUAL_REQUIRED,
          {}
        )
        this.announce(tx, storeId, pickup, PickupManualReasons.NO_API)
      })
      return PickupSyncOutcomes.DONE
    }
    const requestPickup = plugin.requestPickup.bind(plugin)
    const context = buildCarrierContext(
      {
        id: pickup.connection.id,
        storeId,
        credentials: pickup.connection.credentials,
        contact: pickup.connection.contact
      },
      this.cipher
    )
    const sent = pickup.packageCount
    let answer: unknown
    try {
      answer = await withDeadline(() =>
        requestPickup(context, {
          idempotencyKey: pickupRequestKey(pickup.id),
          window: {
            date: pickup.pickupDate.toISOString().slice(0, 10),
            from: pickup.windowStart ?? PickupDefaults.WINDOW_FROM,
            to: pickup.windowEnd ?? PickupDefaults.WINDOW_TO
          },
          packageCount: sent
        })
      )
    } catch (error) {
      return this.requestFailed(storeId, pickup, error, lastAttempt)
    }
    const ref = (answer as { pickupRef?: unknown } | null)?.pickupRef
    if (
      typeof ref !== 'string' ||
      ref === '' ||
      ref.trim() !== ref ||
      ref.length > MAX_PICKUP_REF_LENGTH
    ) {
      await this.end(
        storeId,
        pickup,
        PickupStatus.REQUIRES_REVIEW,
        PickupFailureNotes.UNUSABLE_ANSWER
      )
      return PickupSyncOutcomes.DONE
    }
    // The carrier holds the pickup. Writing it down is outside the try of the call: a fault here is a fault of the database, not
    // of the carrier, and the job asks again with the same key (the carrier answers the same pickup)
    await this.prisma.transaction(async tx => {
      await this.lock(tx, storeId, pickup.connectionId)
      await this.writes.movePickup(
        tx,
        storeId,
        pickup.id,
        PickupStatus.PENDING,
        PickupStatus.REQUESTED,
        { providerPickupId: ref, carrierPackageCount: sent, lastError: null }
      )
    })
    return PickupSyncOutcomes.DONE
  }

  private async requestFailed(
    storeId: string,
    pickup: PickupRow,
    error: unknown,
    lastAttempt: boolean
  ): Promise<PickupSyncOutcome> {
    if (error instanceof CarrierRejectedError) {
      await this.end(storeId, pickup, PickupStatus.FAILED, clampCarrierMessage(error.message))
    } else if (error instanceof CarrierAuthError) {
      await this.end(storeId, pickup, PickupStatus.FAILED, PickupFailureNotes.CREDENTIALS_REJECTED)
    } else if (error instanceof CarrierCredentialsUnreadableError) {
      await this.end(
        storeId,
        pickup,
        PickupStatus.FAILED,
        PickupFailureNotes.CREDENTIALS_UNREADABLE
      )
    } else if (error instanceof CarrierUnavailableError) {
      if (!lastAttempt) return PickupSyncOutcomes.RETRY
      await this.end(storeId, pickup, PickupStatus.FAILED, PickupFailureNotes.UNAVAILABLE)
    } else {
      // Something the platform cannot read: the request may have reached the carrier
      this.logger.error(
        { pickupId: pickup.id, err: String(error) },
        'a pickup request ended in a fault'
      )
      await this.end(
        storeId,
        pickup,
        PickupStatus.REQUIRES_REVIEW,
        PickupFailureNotes.UNKNOWN_OUTCOME
      )
    }
    return PickupSyncOutcomes.DONE
  }

  // The request ends in FAILED (the guides go back to waiting) or REQUIRES_REVIEW (they stay with the pickup until a person settles
  // it), and the team is told either way
  private async end(
    storeId: string,
    pickup: PickupRow,
    to: PickupStatus.FAILED | PickupStatus.REQUIRES_REVIEW,
    note: string,
    tellTeam = true
  ): Promise<void> {
    await this.prisma.transaction(async tx => {
      await this.lock(tx, storeId, pickup.connectionId)
      await this.writes.movePickup(tx, storeId, pickup.id, PickupStatus.PENDING, to, {
        lastError: note
      })
      if (to === PickupStatus.FAILED) {
        await tx.shipment.updateMany({
          where: { storeId, pickupId: pickup.id },
          data: { pickupId: null }
        })
      }
      if (tellTeam) {
        this.announce(
          tx,
          storeId,
          pickup,
          to === PickupStatus.FAILED ? PickupManualReasons.FAILED : PickupManualReasons.REVIEW
        )
      }
    })
  }

  // The same lock `PickupsService` takes: a pickup is never moved while a request joins a guide to it
  private async lock(tx: PrismaTransaction, storeId: string, connectionId: string): Promise<void> {
    await lockStoreForWrite(tx, storeId)
    await lockStoreScope(tx, storeId, `${PickupLockScopes.CONNECTION}:${connectionId}`)
  }

  private announce(
    tx: PrismaTransaction,
    storeId: string,
    pickup: PickupRow,
    reason: (typeof PickupManualReasons)[keyof typeof PickupManualReasons]
  ): void {
    this.events.publish(tx, Events.PICKUP_MANUAL_REQUIRED, {
      storeId,
      pickupId: pickup.id,
      connectionId: pickup.connectionId,
      pickupDate: pickup.pickupDate.toISOString().slice(0, 10),
      packageCount: pickup.packageCount,
      reason
    })
  }

  // ------------------------------------------------------------------------------------------------------------ modify

  private async modify(
    storeId: string,
    pickup: PickupRow,
    plugins: PluginLookup,
    lastAttempt: boolean
  ): Promise<PickupSyncOutcome | typeof MODIFIED> {
    const plugin = plugins(pickup.connection.carrierId)
    const pickupRef = pickup.providerPickupId
    const note = (lastError: string): Promise<unknown> =>
      this.prisma.client.pickupRequest.updateMany({
        where: { id: pickup.id, storeId },
        data: { lastError }
      })
    if (
      pickupRef === null ||
      plugin?.modifyPickup === undefined ||
      !plugin.capabilities.includes(CarrierCapability.PICKUP_MODIFY) ||
      pickup.connection.status !== String(CarrierConnectionStatus.ACTIVE)
    ) {
      await note(PickupLeaveNotes.NOT_UPDATED)
      return PickupSyncOutcomes.DONE
    }
    const modifyPickup = plugin.modifyPickup.bind(plugin)
    const context = buildCarrierContext(
      {
        id: pickup.connection.id,
        storeId,
        credentials: pickup.connection.credentials,
        contact: pickup.connection.contact
      },
      this.cipher
    )
    const sent = pickup.packageCount
    try {
      await withDeadline(() => modifyPickup(context, { pickupRef, packageCount: sent }))
    } catch (error) {
      const mayAskAgain =
        error instanceof CarrierUnavailableError ||
        !(
          error instanceof CarrierRejectedError ||
          error instanceof CarrierAuthError ||
          error instanceof CarrierCredentialsUnreadableError
        )
      if (mayAskAgain && !lastAttempt) return PickupSyncOutcomes.RETRY
      this.logger.warn(
        { pickupId: pickup.id, err: String(error) },
        'a pickup count could not be sent'
      )
      await note(PickupLeaveNotes.NOT_UPDATED)
      return PickupSyncOutcomes.DONE
    }
    // What the carrier has now is what was sent, whatever the count is by the time this lands: a difference is told again
    await this.prisma.client.pickupRequest.updateMany({
      where: {
        id: pickup.id,
        storeId,
        status: { in: [PickupStatus.REQUESTED, PickupStatus.CONFIRMED] }
      },
      data: { carrierPackageCount: sent, lastError: null }
    })
    return MODIFIED
  }
}

interface PickupRow {
  id: string
  connectionId: string
  pickupDate: Date
  status: string
  packageCount: number
  carrierPackageCount: number | null
  providerPickupId: string | null
  windowStart: string | null
  windowEnd: string | null
  connection: {
    id: string
    carrierId: string
    status: string
    credentials: Uint8Array | null
    contact: unknown
  }
}
