import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  type AddPickupShipmentsBody,
  type CursorPage,
  PickupResourceTypes,
  type RequestPickupBody
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  type EnsurePickupResult,
  type PickupManifest,
  PickupsService as CorePickups
} from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import { PickupQueue } from './pickup-queue.service'
import type { ListPickupsQuery } from './pickups.schemas'
import {
  PICKUP_SELECT,
  type PickupRequestView,
  type PickupRow,
  type PickupView,
  pickupViewOf
} from './pickups.views'

const ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const
const dayStart = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

// The pickups of the store of the request (TDD_17 §4.10, §6): the permission of each route is checked by the controller and the
// store is the one TenantGuard resolved. `PickupsService` of the core does the work under its lock and is the only place a pickup
// is made or joined; this adds the audit entry, the job that tells the carrier, and the shapes of the answers.
@Injectable()
export class PickupsApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pickups: CorePickups,
    private readonly queue: PickupQueue,
    private readonly registry: CarrierRegistry,
    private readonly audit: AuditService
  ) {}

  private readonly plugins = (carrierId: string) => this.registry.find(carrierId)

  async list(storeId: string, query: ListPickupsQuery): Promise<CursorPage<PickupView>> {
    const { cursor, limit } = query
    const rows = await this.prisma.client.pickupRequest.findMany({
      where: {
        storeId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.connectionId === undefined ? {} : { connectionId: query.connectionId }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              pickupDate: {
                ...(query.from === undefined ? {} : { gte: dayStart(query.from) }),
                ...(query.to === undefined ? {} : { lte: dayStart(query.to) })
              }
            }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: PICKUP_SELECT,
      orderBy: [...ORDER],
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => pickupViewOf(row)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  // Request a pickup now, of the guides named or of every guide that waits: the same call the scheduler makes, so a request that
  // races it ends with one pickup
  async request(
    storeId: string,
    body: RequestPickupBody,
    actor: Actor
  ): Promise<PickupRequestView> {
    const result = await this.pickups.ensurePickup(
      storeId,
      {
        connectionId: body.connectionId,
        shipmentIds: body.shipmentIds,
        date: body.date,
        confirmAfterCutoff: body.confirmAfterCutoff,
        actor: { type: 'user', id: actor.userId }
      },
      this.plugins
    )
    return this.answer(storeId, result, actor, true)
  }

  async addShipments(
    storeId: string,
    pickupId: string,
    body: AddPickupShipmentsBody,
    actor: Actor
  ): Promise<PickupRequestView> {
    const pickup = await this.rowOf(storeId, pickupId)
    const result = await this.pickups.ensurePickup(
      storeId,
      {
        connectionId: pickup.connectionId,
        shipmentIds: body.shipmentIds,
        date: pickup.pickupDate.toISOString().slice(0, 10),
        confirmAfterCutoff: body.confirmAfterCutoff,
        actor: { type: 'user', id: actor.userId }
      },
      this.plugins
    )
    // The pickup was cancelled or is over: a new one must not appear behind the back of the agent
    if (result.pickupId !== pickupId) {
      throw new PlatformException(
        ErrorCodes.PICKUP_NOT_EDITABLE,
        'the pickup is over',
        HttpStatusCodes.CONFLICT
      )
    }
    return this.answer(storeId, result, actor, false)
  }

  async removeShipment(
    storeId: string,
    pickupId: string,
    shipmentId: string,
    actor: Actor
  ): Promise<PickupView> {
    const change = await this.pickups.removeShipment(storeId, pickupId, shipmentId)
    if (change.sync) await this.queue.enqueue(storeId, pickupId, change.revision, actor.userId)
    this.record(storeId, AuditAction.PICKUP_MODIFIED, pickupId, actor, { removed: shipmentId })
    return pickupViewOf(await this.rowOf(storeId, pickupId))
  }

  async confirm(storeId: string, pickupId: string, actor: Actor): Promise<PickupView> {
    await this.pickups.confirm(storeId, pickupId)
    this.record(storeId, AuditAction.PICKUP_MODIFIED, pickupId, actor, { confirmed: true })
    return pickupViewOf(await this.rowOf(storeId, pickupId))
  }

  async cancel(storeId: string, pickupId: string, actor: Actor): Promise<PickupView> {
    await this.pickups.cancel(storeId, pickupId, this.plugins)
    this.record(storeId, AuditAction.PICKUP_CANCELLED, pickupId, actor, {})
    return pickupViewOf(await this.rowOf(storeId, pickupId))
  }

  manifest(storeId: string, pickupId: string): Promise<PickupManifest> {
    return this.pickups.manifest(storeId, pickupId)
  }

  private async answer(
    storeId: string,
    result: EnsurePickupResult,
    actor: Actor,
    requested: boolean
  ): Promise<PickupRequestView> {
    if (result.pickupId === null) {
      throw new PlatformException(
        ErrorCodes.PICKUP_NOTHING_TO_COLLECT,
        'no guide is waiting for a pickup',
        HttpStatusCodes.CONFLICT
      )
    }
    if (result.sync) {
      await this.queue.enqueue(storeId, result.pickupId, result.revision, actor.userId)
    }
    if (result.created || result.joined.length > 0) {
      this.record(
        storeId,
        result.created && requested ? AuditAction.PICKUP_REQUESTED : AuditAction.PICKUP_MODIFIED,
        result.pickupId,
        actor,
        { joined: result.joined.length, waiting: result.waiting.length }
      )
    }
    return {
      pickup: pickupViewOf(await this.rowOf(storeId, result.pickupId)),
      created: result.created,
      joined: [...result.joined],
      waiting: result.waiting.map(wait => ({ ...wait }))
    }
  }

  private async rowOf(storeId: string, pickupId: string): Promise<PickupRow> {
    const row = await this.prisma.client.pickupRequest.findFirst({
      where: { id: pickupId, storeId },
      select: PICKUP_SELECT
    })
    if (row === null) throw resourceNotFound('pickup')
    return row
  }

  private record(
    storeId: string,
    action: (typeof AuditAction)[keyof typeof AuditAction],
    pickupId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: PickupResourceTypes.PICKUP,
      resourceId: pickupId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
