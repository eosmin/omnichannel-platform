import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  WarehouseConflicts,
  WarehouseLockScopes,
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

import type { Actor } from '../tenancy'

import type { PutWarehouseStoresBody } from './warehouses.schemas'
import { lockWarehouse } from './warehouses.support'
import { WAREHOUSE_SELECT, type WarehouseView, warehouseView } from './warehouses.views'

interface Link {
  id: string
  warehouseId: string
  priority: number
}

// Which warehouses a store sells from, and in which order (TDD_16 §1, §4.1, §4.7). The links of one warehouse are
// replaced as a whole, in one transaction, and the priorities of every store it touches are renumbered 1..n in the
// same one: the unique (store, priority) is DEFERRABLE, so no step in between can clash.
@Injectable()
export class WarehouseLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async replace(
    organizationId: string,
    warehouseId: string,
    body: PutWarehouseStoresBody,
    actor: Actor
  ): Promise<WarehouseView> {
    const wanted = new Map(body.stores.map(link => [link.storeId, link.priority]))
    const summary = await this.prisma.transaction(async tx => {
      const warehouse = await lockWarehouse(tx, organizationId, warehouseId)
      // A store of another organization, and one that does not exist, are the same answer
      if (wanted.size > 0) {
        const found = await tx.store.count({
          where: { id: { in: [...wanted.keys()] }, organizationId }
        })
        if (found !== wanted.size) throw resourceNotFound('store')
      }
      const own = await tx.storeWarehouse.findMany({
        where: { warehouseId },
        select: { storeId: true }
      })
      const had = new Set(own.map(link => link.storeId))
      // The stores whose lists change: the writers of one store take turns, always in the same order of stores
      const touched = [...new Set([...had, ...wanted.keys()])].sort()
      for (const storeId of touched) {
        // A delete of the store waits for this write (and its cascade finds no link we hold)
        await lockStoreForWrite(tx, storeId)
        await lockStoreScope(tx, storeId, WarehouseLockScopes.STORE_LINKS)
      }
      const added = [...wanted.keys()].filter(storeId => !had.has(storeId))
      if (added.length > 0 && !warehouse.active) {
        throw resourceConflict('a warehouse that is switched off takes no new store', {
          conflict: WarehouseConflicts.INACTIVE
        })
      }
      const removed = [...had].filter(storeId => !wanted.has(storeId))
      const before = await this.placesOf(tx, warehouseId)
      await this.unlink(tx, warehouseId, removed)
      for (const storeId of touched) {
        await this.arrange(tx, {
          organizationId,
          storeId,
          warehouseId,
          priority: wanted.get(storeId),
          wanted: wanted.has(storeId)
        })
      }
      // What this request left, read inside it: another request cannot slip its own result into the entry
      const after = await this.placesOf(tx, warehouseId)
      const moved = [...after].some(([storeId, priority]) => before.get(storeId) !== priority)
      return { added, removed, after, changed: added.length > 0 || removed.length > 0 || moved }
    })
    const view = await this.read(organizationId, warehouseId)
    // A request that changes nothing leaves no entry
    if (!summary.changed) return view
    this.audit.log({
      action: AuditAction.WAREHOUSE_UPDATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: WarehouseResourceTypes.STORE_LINKS,
      resourceId: warehouseId,
      metadata: {
        change: 'stores',
        added: summary.added,
        removed: summary.removed,
        stores: [...summary.after].map(([storeId, priority]) => ({ storeId, priority }))
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return view
  }

  private async placesOf(tx: PrismaTransaction, warehouseId: string): Promise<Map<string, number>> {
    const rows = await tx.storeWarehouse.findMany({
      where: { warehouseId },
      select: { storeId: true, priority: true }
    })
    return new Map(rows.map(row => [row.storeId, row.priority]))
  }

  private async read(organizationId: string, warehouseId: string): Promise<WarehouseView> {
    const row = await this.prisma.client.warehouse.findFirst({
      where: { id: warehouseId, organizationId },
      select: WAREHOUSE_SELECT
    })
    if (row === null) throw resourceNotFound('warehouse')
    return warehouseView(row)
  }

  // A store gives the warehouse up only when it has no units reserved there (TDD_16 §4.7). The links are deleted
  // first: a reservation in flight holds its link row shared, so the delete waits for it, and the check that follows
  // sees what it committed. If the check fails the transaction rolls the delete back.
  private async unlink(
    tx: PrismaTransaction,
    warehouseId: string,
    storeIds: string[]
  ): Promise<void> {
    if (storeIds.length === 0) return
    await tx.storeWarehouse.deleteMany({ where: { warehouseId, storeId: { in: storeIds } } })
    const reserved = await tx.inventoryLevel.findFirst({
      where: { warehouseId, storeId: { in: storeIds }, reserved: { gt: 0 } },
      select: { storeId: true }
    })
    if (reserved !== null) {
      throw new PlatformException(
        ErrorCodes.INVENTORY_WAREHOUSE_HAS_STOCK,
        'the store has units reserved in the warehouse',
        HttpStatusCodes.CONFLICT,
        { reason: WarehouseStockBlocks.UNLINK, storeId: reserved.storeId }
      )
    }
  }

  // The list of one store with the warehouse in its place, every priority renumbered 1..n
  private async arrange(
    tx: PrismaTransaction,
    input: {
      organizationId: string
      storeId: string
      warehouseId: string
      priority: number | undefined
      wanted: boolean
    }
  ): Promise<void> {
    const { organizationId, storeId, warehouseId } = input
    const links: Link[] = await tx.storeWarehouse.findMany({
      where: { storeId },
      select: { id: true, warehouseId: true, priority: true },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }]
    })
    const others = links.filter(link => link.warehouseId !== warehouseId)
    const existing = links.find(link => link.warehouseId === warehouseId)
    const order: { id: string | null; warehouseId: string }[] = others.map(link => ({
      id: link.id,
      warehouseId: link.warehouseId
    }))
    if (input.wanted) {
      const place =
        input.priority !== undefined
          ? Math.min(input.priority, others.length + 1) - 1
          : existing === undefined
            ? others.length
            : links.indexOf(existing)
      order.splice(place, 0, { id: existing?.id ?? null, warehouseId })
    }
    const priorityOf = new Map(links.map(link => [link.id, link.priority]))
    for (const [index, entry] of order.entries()) {
      const priority = index + 1
      if (entry.id === null) {
        await tx.storeWarehouse.create({
          data: { organizationId, storeId, warehouseId: entry.warehouseId, priority }
        })
      } else if (priorityOf.get(entry.id) !== priority) {
        await tx.storeWarehouse.update({ where: { id: entry.id }, data: { priority } })
      }
    }
  }
}
