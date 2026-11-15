import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import { FinanceResourceTypes } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { readFinancePreferences } from '@platform/core/store-preferences'

import type { Actor } from '../tenancy'

import type { UpdateStoreTaxSettingsBody } from './finance.schemas'
import type { StoreTaxSettingsView } from './finance.views'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

const asRecord = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}

// The tax preferences of one store (TDD_18 §7): whether its prices include the tax. They live in the preferences of the store
// (the orders read them from there) and are written here, under finance:manage_accounts, because whether a price carries the tax
// decides what the customer pays and what the books owe, which `settings:manage_preferences` does not cover. A change moves the
// orders made after it; the tax of an order that exists is a snapshot.
@Injectable()
export class FinanceStoreTaxSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  async get(storeId: string): Promise<StoreTaxSettingsView> {
    const row = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    if (row === null) throw resourceNotFound('store settings')
    return { pricesIncludeTax: readFinancePreferences(row.preferences).pricesIncludeTax }
  }

  async update(
    organizationId: string,
    storeId: string,
    body: UpdateStoreTaxSettingsBody,
    actor: Actor
  ): Promise<StoreTaxSettingsView> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The same lock as `PUT /settings/preferences`: two writers of the one column would lose one of the changes
      await lockStoreScope(tx, storeId, 'preferences')
      const current = await tx.storeSettings.findUnique({
        where: { storeId },
        select: { preferences: true }
      })
      if (current === null) throw resourceNotFound('store settings')
      const base = asRecord(current.preferences)
      const before = readFinancePreferences(base)
      if (
        body.pricesIncludeTax === undefined ||
        body.pricesIncludeTax === before.pricesIncludeTax
      ) {
        return { view: { pricesIncludeTax: before.pricesIncludeTax }, changed: false }
      }
      await tx.storeSettings.update({
        where: { storeId },
        data: {
          preferences: {
            ...base,
            finance: { ...asRecord(base['finance']), pricesIncludeTax: body.pricesIncludeTax }
          }
        }
      })
      this.events.publish(tx, Events.STORE_SETTINGS_UPDATED, { storeId })
      return {
        view: { pricesIncludeTax: body.pricesIncludeTax },
        changed: true,
        from: before.pricesIncludeTax
      }
    })
    if (outcome.changed) {
      this.audit.log({
        action: AuditAction.FINANCE_SETTINGS_CHANGED,
        actor: { userId: actor.userId },
        organizationId,
        storeId,
        resourceType: FinanceResourceTypes.STORE_TAX_SETTINGS,
        resourceId: storeId,
        metadata: {
          fields: ['pricesIncludeTax'],
          changes: { pricesIncludeTax: { from: outcome.from, to: outcome.view.pricesIncludeTax } }
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return outcome.view
  }
}
