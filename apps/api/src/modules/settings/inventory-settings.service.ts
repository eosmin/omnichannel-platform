import { Injectable } from '@nestjs/common'

import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import { WarehouseLockScopes, WarehouseResourceTypes } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { UpdateInventorySettingsBody } from './settings.schemas'
import { auditSettingsChange } from './settings.support'

export interface InventorySettingsView {
  allowNegativeStock: boolean
  allowSplitFulfillment: boolean
  defaultLowStockThreshold: number | null
}

const INVENTORY_SELECT = {
  allowNegativeStock: true,
  allowSplitFulfillment: true,
  defaultLowStockThreshold: true
} as const

// The inventory switches of a store (TDD_16 §4.10): negative stock, split fulfillment and the threshold a new product
// starts with. They belong to the store of the request. Changing one never touches stock: the rules that read them
// (InventoryService, orders) read them when they act.
@Injectable()
export class InventorySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(storeId: string): Promise<InventorySettingsView> {
    const row = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: INVENTORY_SELECT
    })
    if (row === null) throw resourceNotFound('store settings')
    return row
  }

  async update(
    storeId: string,
    body: UpdateInventorySettingsBody,
    actor: Actor
  ): Promise<InventorySettingsView> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Two writers read the row and write it back: they take turns, so each entry of the audit has the true "from"
      await lockStoreScope(tx, storeId, WarehouseLockScopes.INVENTORY_SETTINGS)
      const before = await tx.storeSettings.findUnique({
        where: { storeId },
        select: INVENTORY_SELECT
      })
      if (before === null) throw resourceNotFound('store settings')
      const after = await tx.storeSettings.update({
        where: { storeId },
        data: {
          ...(body.allowNegativeStock === undefined
            ? {}
            : { allowNegativeStock: body.allowNegativeStock }),
          ...(body.allowSplitFulfillment === undefined
            ? {}
            : { allowSplitFulfillment: body.allowSplitFulfillment }),
          ...(body.defaultLowStockThreshold === undefined
            ? {}
            : { defaultLowStockThreshold: body.defaultLowStockThreshold })
        },
        select: INVENTORY_SELECT
      })
      // Which switches really changed, from what to what (switches and a number, no personal data)
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const key of Object.keys(after) as (keyof InventorySettingsView)[]) {
        if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] }
      }
      return { after, changes }
    })
    // A request that changes nothing leaves no entry
    if (Object.keys(outcome.changes).length > 0) {
      auditSettingsChange(
        this.audit,
        storeId,
        actor,
        WarehouseResourceTypes.INVENTORY_SETTINGS,
        storeId,
        { change: 'updated', fields: Object.keys(outcome.changes), changes: outcome.changes }
      )
    }
    return outcome.after
  }
}
