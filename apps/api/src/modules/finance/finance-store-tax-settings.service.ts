import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { FinanceResourceTypes } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { readFinancePreferences } from '@platform/core/store-preferences'

import { writeFinancePricesIncludeTax } from '../settings/preferences.service'
import type { Actor } from '../tenancy'

import type { UpdateStoreTaxSettingsBody } from './finance.schemas'
import type { StoreTaxSettingsView } from './finance.views'

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
    const before = await this.get(storeId)
    if (body.pricesIncludeTax === undefined || body.pricesIncludeTax === before.pricesIncludeTax) {
      return before
    }
    const { from, to } = await writeFinancePricesIncludeTax(
      this.prisma,
      this.events,
      storeId,
      body.pricesIncludeTax
    )
    if (from !== to) {
      this.audit.log({
        action: AuditAction.FINANCE_SETTINGS_CHANGED,
        actor: { userId: actor.userId },
        organizationId,
        storeId,
        resourceType: FinanceResourceTypes.STORE_TAX_SETTINGS,
        resourceId: storeId,
        metadata: { fields: ['pricesIncludeTax'], changes: { pricesIncludeTax: { from, to } } },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return { pricesIncludeTax: to }
  }
}
