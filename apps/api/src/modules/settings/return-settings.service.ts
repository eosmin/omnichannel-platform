import { Injectable } from '@nestjs/common'

import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import { ReturnLockScopes, ReturnResourceTypes, type ShippingPayer } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { UpdateReturnSettingsBody } from './settings.schemas'
import { auditSettingsChange } from './settings.support'

export interface ReturnSettingsView {
  returnShippingPayer: ShippingPayer
}

const RETURN_SELECT = { returnShippingPayer: true } as const

// The returns settings of a store (TDD_17 §4.11): who pays the return leg and the shipping of a replacement when a return does
// not say. It belongs to the store of the request; changing it never touches a return that exists (each keeps its own payer).
@Injectable()
export class ReturnSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(storeId: string): Promise<ReturnSettingsView> {
    const row = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: RETURN_SELECT
    })
    if (row === null) throw resourceNotFound('store settings')
    return { returnShippingPayer: row.returnShippingPayer as ShippingPayer }
  }

  async update(
    storeId: string,
    body: UpdateReturnSettingsBody,
    actor: Actor
  ): Promise<ReturnSettingsView> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Two writers read the row and write it back: they take turns, so each entry of the audit has the true "from"
      await lockStoreScope(tx, storeId, ReturnLockScopes.RETURN_SETTINGS)
      const before = await tx.storeSettings.findUnique({
        where: { storeId },
        select: RETURN_SELECT
      })
      if (before === null) throw resourceNotFound('store settings')
      const after =
        body.returnShippingPayer === undefined
          ? before
          : await tx.storeSettings.update({
              where: { storeId },
              data: { returnShippingPayer: body.returnShippingPayer },
              select: RETURN_SELECT
            })
      return { after, changed: before.returnShippingPayer !== after.returnShippingPayer, before }
    })
    // A request that changes nothing leaves no entry
    if (outcome.changed) {
      auditSettingsChange(
        this.audit,
        storeId,
        actor,
        ReturnResourceTypes.RETURN_SETTINGS,
        storeId,
        {
          change: 'updated',
          fields: ['returnShippingPayer'],
          changes: {
            returnShippingPayer: {
              from: outcome.before.returnShippingPayer,
              to: outcome.after.returnShippingPayer
            }
          }
        }
      )
    }
    return { returnShippingPayer: outcome.after.returnShippingPayer as ShippingPayer }
  }
}
