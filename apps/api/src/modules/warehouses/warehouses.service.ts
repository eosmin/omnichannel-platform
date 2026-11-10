import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { DatabaseNull, lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  WarehouseLimits,
  WarehouseResourceTypes,
  WarehouseStockBlocks
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type {
  CreateWarehouseBody,
  ListWarehousesQuery,
  UpdateWarehouseBody
} from './warehouses.schemas'
import { codeTransaction, lockOrganizationWarehouses, lockWarehouse } from './warehouses.support'
import {
  WAREHOUSE_SELECT,
  type WarehousePage,
  type WarehouseView,
  warehouseView
} from './warehouses.views'

// The database keeps the keys of a json object in an order of its own: two addresses are the same when their fields are
function sameAddress(a: unknown, b: unknown): boolean {
  const fields = (value: unknown): string =>
    JSON.stringify(
      typeof value === 'object' && value !== null
        ? Object.entries(value).sort(([x], [y]) => x.localeCompare(y))
        : null
    )
  return fields(a) === fields(b)
}

// The warehouses of the organization of the request. `organizationId` comes from TenantGuard and is the only one
// read here: never from the body or the query string (CLAUDE.md rule 2). The links to stores are `WarehouseLinksService`.
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(organizationId: string, query: ListWarehousesQuery): Promise<WarehousePage> {
    const { cursor } = query
    const rows = await this.prisma.client.warehouse.findMany({
      where: {
        organizationId,
        ...(query.active === undefined ? {} : { active: query.active }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } }
              ]
            })
      },
      select: WAREHOUSE_SELECT,
      take: query.limit + 1,
      // The oldest first: the first warehouse is the one the owner made with the store
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(warehouseView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(organizationId: string, warehouseId: string): Promise<WarehouseView> {
    const row = await this.prisma.client.warehouse.findFirst({
      where: { id: warehouseId, organizationId },
      select: WAREHOUSE_SELECT
    })
    if (row === null) throw resourceNotFound('warehouse')
    return warehouseView(row)
  }

  async create(
    organizationId: string,
    body: CreateWarehouseBody,
    actor: Actor
  ): Promise<WarehouseView> {
    const id = await codeTransaction(this.prisma, async tx => {
      // The store of the request exists while the warehouse is written (a delete of it waits for this)
      await lockStoreForWrite(tx, actor.storeId)
      await lockOrganizationWarehouses(tx, organizationId)
      const count = await tx.warehouse.count({ where: { organizationId } })
      if (count >= WarehouseLimits.MAX_PER_ORGANIZATION) {
        throw resourceConflict(
          `an organization holds at most ${WarehouseLimits.MAX_PER_ORGANIZATION} warehouses`,
          { limit: WarehouseLimits.MAX_PER_ORGANIZATION }
        )
      }
      const created = await tx.warehouse.create({
        data: {
          organizationId,
          name: body.name,
          code: body.code,
          ...(body.address === undefined ? {} : { address: body.address })
        },
        select: { id: true }
      })
      return created.id
    })
    this.audit.log({
      action: AuditAction.WAREHOUSE_CREATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: WarehouseResourceTypes.WAREHOUSE,
      resourceId: id,
      metadata: { name: body.name, code: body.code },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, id)
  }

  async update(
    organizationId: string,
    warehouseId: string,
    body: UpdateWarehouseBody,
    actor: Actor
  ): Promise<WarehouseView> {
    const before = await codeTransaction(this.prisma, async tx => {
      const locked = await lockWarehouse(tx, organizationId, warehouseId)
      if (body.active === false && locked.active) {
        await this.refuseWhileItHoldsStock(tx, warehouseId)
      }
      await tx.warehouse.update({
        where: { id: warehouseId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.code === undefined ? {} : { code: body.code }),
          ...(body.address === undefined
            ? {}
            : { address: body.address === null ? DatabaseNull : body.address }),
          ...(body.active === undefined ? {} : { active: body.active })
        }
      })
      return locked
    })
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const fields: string[] = []
    if (body.name !== undefined && body.name !== before.name) {
      changes['name'] = { from: before.name, to: body.name }
    }
    if (body.code !== undefined && body.code !== before.code) {
      changes['code'] = { from: before.code, to: body.code }
    }
    if (body.active !== undefined && body.active !== before.active) {
      changes['active'] = { from: before.active, to: body.active }
    }
    fields.push(...Object.keys(changes))
    // The address is a text object: the entry says it changed, the log does not keep the text
    if (body.address !== undefined && sameAddress(body.address, before.address) === false) {
      fields.push('address')
    }
    // A request that changes nothing leaves no entry
    if (fields.length === 0) return this.get(organizationId, warehouseId)
    this.audit.log({
      action: AuditAction.WAREHOUSE_UPDATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: WarehouseResourceTypes.WAREHOUSE,
      resourceId: warehouseId,
      metadata: { change: 'updated', fields, changes },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, warehouseId)
  }

  // A warehouse with units, reservations or a negative level in any store of the organization is not switched off
  // (TDD_16 §4.7): the owner moves or counts the stock first. The warehouse row is locked by the caller, and the
  // movements of stock lock it shared, so none can slip in between this read and the commit.
  private async refuseWhileItHoldsStock(
    tx: Parameters<typeof lockWarehouse>[0],
    warehouseId: string
  ): Promise<void> {
    const held = await tx.inventoryLevel.findFirst({
      where: { warehouseId, OR: [{ onHand: { not: 0 } }, { reserved: { not: 0 } }] },
      select: { id: true }
    })
    if (held !== null) {
      throw new PlatformException(
        ErrorCodes.INVENTORY_WAREHOUSE_HAS_STOCK,
        'the warehouse still holds stock',
        HttpStatusCodes.CONFLICT,
        { reason: WarehouseStockBlocks.DEACTIVATE }
      )
    }
  }
}
