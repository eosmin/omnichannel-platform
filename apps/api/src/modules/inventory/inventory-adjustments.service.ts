import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { InventoryReferenceType, ProductResourceTypes } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { InventoryService } from '@platform/core/inventory'

import type { Actor } from '../tenancy'

import type { CreateAdjustmentBody } from './inventory.schemas'
import { type AdjustmentView, movementView } from './inventory.views'

// Receiving stock and correcting it by hand (TDD_16 §4.3). The movement is InventoryService's; this adds who did it,
// the audit entry and the cost permission.
@Injectable()
export class InventoryAdjustmentsService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly audit: AuditService
  ) {}

  async adjust(
    storeId: string,
    body: CreateAdjustmentBody,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<AdjustmentView> {
    const canSeeCost = held.includes(Permissions.PRODUCTS_VIEW_COST)
    // The cost of the units is the margin of the store: a caller who may not see it may not set it either
    if (body.unitCostCents !== undefined && !canSeeCost) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'setting the cost of the units needs products:view_cost',
        HttpStatusCodes.FORBIDDEN
      )
    }
    const { movement, replayed } = await this.inventory.move({
      storeId,
      productId: body.productId,
      variantId: body.variantId ?? null,
      warehouseId: body.warehouseId,
      type: body.type,
      quantity: body.quantity,
      idempotencyKey: body.idempotencyKey,
      unitCostCents: body.unitCostCents ?? null,
      reason: body.reason ?? null,
      note: body.note ?? null,
      reference: { type: InventoryReferenceType.MANUAL },
      createdBy: actor.userId
    })
    // A retry applied nothing: it is not a second change to record
    if (!replayed) {
      this.audit.log({
        action: AuditAction.INVENTORY_ADJUSTED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: ProductResourceTypes.PRODUCT,
        resourceId: body.productId,
        metadata: {
          movementId: movement.id,
          type: movement.type,
          quantity: movement.quantity,
          reason: movement.reason,
          warehouseId: movement.warehouseId,
          variantId: movement.variantId,
          onHandAfter: movement.onHandAfter
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return { movement: movementView(movement, canSeeCost), replayed }
  }
}
