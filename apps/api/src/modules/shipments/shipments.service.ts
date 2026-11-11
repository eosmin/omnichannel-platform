import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  type CreateShipmentBody,
  type CursorPage,
  MediaStatus,
  type SetShipmentStatusBody,
  ShipmentPrintableStatuses,
  ShipmentResourceTypes,
  ShipmentStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { type ShipmentChange, ShippingService } from '@platform/core/shipping'
import { StorageService } from '@platform/core/storage-module'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type { ListShipmentsQuery } from './shipments.schemas'
import {
  type CheckResultView,
  type LabelLinkView,
  SHIPMENT_SELECT,
  type ShipmentDetailView,
  type ShipmentRow,
  type ShipmentView,
  shipmentViewOf
} from './shipments.views'

const EVENT_LIMIT = 100
const ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const

// The shipments of the store of the request (TDD_17 §4.5 to §4.8, §6): what an agent asks of them, with the permission of
// each route checked by the controller and the store the one TenantGuard resolved. The engine (ShippingService) does the
// work and is the only writer of a status; this adds the audit entry of each change and the shapes of the answers.
@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingService,
    private readonly registry: CarrierRegistry,
    private readonly storage: StorageService,
    private readonly audit: AuditService
  ) {}

  private readonly plugins = (carrierId: string) => this.registry.find(carrierId)

  async list(storeId: string, query: ListShipmentsQuery): Promise<CursorPage<ShipmentView>> {
    const { cursor, limit } = query
    const rows = await this.prisma.client.shipment.findMany({
      where: {
        storeId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.connectionId === undefined ? {} : { connectionId: query.connectionId }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              createdAt: {
                ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
                ...(query.to === undefined ? {} : { lte: new Date(query.to) })
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
      select: SHIPMENT_SELECT,
      orderBy: [...ORDER],
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => shipmentViewOf(row)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(storeId: string, shipmentId: string): Promise<ShipmentDetailView> {
    const row = await this.rowOf(storeId, shipmentId)
    const events = await this.prisma.client.shipmentEvent.findMany({
      where: { storeId, shipmentId },
      orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
      take: EVENT_LIMIT,
      select: {
        id: true,
        status: true,
        rawStatus: true,
        description: true,
        occurredAt: true,
        source: true
      }
    })
    return {
      ...shipmentViewOf(row),
      events: events.map(event => ({ ...event, occurredAt: event.occurredAt.toISOString() }))
    }
  }

  // POST /orders/:id/shipments: one guide. What the engine could not make is answered with its own code, and a refusal that
  // came after the row was written names the shipment so the screen can open it.
  async create(
    storeId: string,
    orderId: string,
    body: CreateShipmentBody,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<ShipmentView> {
    const [outcome] = await this.shipping.createShipments(
      storeId,
      [{ ...body, orderId }],
      {
        actor: { type: 'user', id: actor.userId },
        canOverridePrice: held.includes(Permissions.ORDERS_OVERRIDE_PRICE)
      },
      this.plugins
    )
    if (outcome === undefined) throw resourceNotFound('order')
    if (!outcome.ok) {
      // A guide that was written and then refused, or whose outcome is unknown, may exist at the carrier and may cost money:
      // who asked for it is on record
      if (outcome.shipmentId !== undefined) {
        this.record(storeId, AuditAction.SHIPMENT_CREATED, outcome.shipmentId, actor, {
          orderId,
          refused: outcome.error.code
        })
      }
      throw outcome.error
    }
    const view = shipmentViewOf(await this.rowOf(storeId, outcome.shipmentId))
    this.record(storeId, AuditAction.SHIPMENT_CREATED, outcome.shipmentId, actor, {
      orderId,
      status: view.status,
      connectionId: view.connectionId
    })
    return view
  }

  // GET /shipments/:id/label: a short-lived link to the stored file. A voided or unfinished label is never served, and a
  // file the scan did not clear is not a label (TDD_17 §4.6)
  async label(storeId: string, shipmentId: string): Promise<LabelLinkView> {
    const row = await this.rowOf(storeId, shipmentId)
    if (
      row.labelMediaId === null ||
      !ShipmentPrintableStatuses.includes(row.status as ShipmentStatus)
    ) {
      throw this.noLabel()
    }
    const media = await this.prisma.client.media.findFirst({
      where: { id: row.labelMediaId, storeId },
      select: { key: true, filename: true, contentType: true, status: true }
    })
    if (media === null || media.status !== String(MediaStatus.CLEAN)) throw this.noLabel()
    const url = await this.storage.downloadUrl({
      key: media.key,
      filename: media.filename,
      contentType: media.contentType
    })
    return { url, filename: media.filename }
  }

  async setStatus(
    storeId: string,
    shipmentId: string,
    body: SetShipmentStatusBody,
    actor: Actor
  ): Promise<ShipmentView> {
    const change = await this.shipping.setManualStatus(storeId, shipmentId, body, {
      type: 'user',
      id: actor.userId
    })
    this.record(storeId, AuditAction.SHIPMENT_STATUS_SET_MANUALLY, shipmentId, actor, {
      orderId: change.orderId,
      from: change.from,
      to: change.to
    })
    return shipmentViewOf(await this.rowOf(storeId, shipmentId))
  }

  async cancel(storeId: string, shipmentId: string, actor: Actor): Promise<ShipmentView> {
    const change = await this.shipping.cancel(
      storeId,
      shipmentId,
      { type: 'user', id: actor.userId },
      this.plugins
    )
    this.audited(storeId, change, actor)
    return shipmentViewOf(await this.rowOf(storeId, shipmentId))
  }

  async markVoided(storeId: string, shipmentId: string, actor: Actor): Promise<ShipmentView> {
    const change = await this.shipping.markVoided(storeId, shipmentId, {
      type: 'user',
      id: actor.userId
    })
    this.audited(storeId, change, actor)
    return shipmentViewOf(await this.rowOf(storeId, shipmentId))
  }

  async check(storeId: string, shipmentId: string, actor: Actor): Promise<CheckResultView> {
    const result = await this.shipping.checkWithCarrier(
      storeId,
      shipmentId,
      { type: 'user', id: actor.userId },
      this.plugins
    )
    if (result.change !== null) {
      this.record(storeId, AuditAction.SHIPMENT_STATUS_SET_MANUALLY, shipmentId, actor, {
        orderId: result.change.orderId,
        from: result.change.from,
        to: result.change.to,
        checkedWithCarrier: true
      })
    }
    return {
      found: result.found,
      shipment: shipmentViewOf(await this.rowOf(storeId, shipmentId))
    }
  }

  // A guide that is voided is a cancellation; one that is only on its way to be (pending, or failed to be) is a status set by hand
  private audited(storeId: string, change: ShipmentChange, actor: Actor): void {
    const action =
      change.to === ShipmentStatus.CANCELLED
        ? AuditAction.SHIPMENT_CANCELLED
        : AuditAction.SHIPMENT_STATUS_SET_MANUALLY
    this.record(storeId, action, change.shipmentId, actor, {
      orderId: change.orderId,
      from: change.from,
      to: change.to
    })
  }

  private async rowOf(storeId: string, shipmentId: string): Promise<ShipmentRow> {
    const row = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId, storeId },
      select: SHIPMENT_SELECT
    })
    if (row === null) throw resourceNotFound('shipment')
    return row
  }

  private noLabel(): PlatformException {
    return new PlatformException(
      ErrorCodes.SHIPPING_LABEL_NOT_AVAILABLE,
      'the label is not available',
      HttpStatusCodes.CONFLICT
    )
  }

  private record(
    storeId: string,
    action: (typeof AuditAction)[keyof typeof AuditAction],
    shipmentId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: ShipmentResourceTypes.SHIPMENT,
      resourceId: shipmentId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
