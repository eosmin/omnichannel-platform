import { Injectable } from '@nestjs/common'

import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'
import {
  readStorePreferences,
  type StorePreferences,
  type UpdateStorePreferencesBody
} from '@platform/core/store-preferences'

import type { Actor } from '../tenancy'

import { auditSettingsChange } from './settings.support'

// What a store may change without a deploy (StoreSettings.preferences). The column holds only what the
// store chose; what it did not choose reads as the factory default of `storePreferencesSchema`.
@Injectable()
export class PreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(storeId: string): Promise<StorePreferences> {
    const row = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    if (row === null) throw resourceNotFound('store settings')
    return readStorePreferences(row.preferences)
  }

  async update(
    storeId: string,
    body: UpdateStorePreferencesBody,
    actor: Actor
  ): Promise<StorePreferences> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The store lock is a shared one: two writers that read the column and write it back would lose
      // one of the changes, so they take turns
      await lockStoreScope(tx, storeId, 'preferences')
      const current = await tx.storeSettings.findUnique({
        where: { storeId },
        select: { preferences: true }
      })
      if (current === null) throw resourceNotFound('store settings')
      // Merged over what is stored, key by key: a key this version does not know stays as it is
      const base =
        typeof current.preferences === 'object' &&
        current.preferences !== null &&
        !Array.isArray(current.preferences)
          ? current.preferences
          : {}
      const changes = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined)
      )
      const before = readStorePreferences(base)
      const row = await tx.storeSettings.update({
        where: { storeId },
        data: { preferences: { ...base, ...changes } },
        select: { preferences: true }
      })
      const after = readStorePreferences(row.preferences)
      // Which keys really changed, from what to what (switches, not personal data)
      const diff: Record<string, { from: unknown; to: unknown }> = {}
      for (const key of Object.keys(after) as (keyof StorePreferences)[]) {
        if (before[key] !== after[key]) diff[key] = { from: before[key], to: after[key] }
      }
      return { after, diff }
    })
    // A request that changes nothing leaves no entry
    if (Object.keys(outcome.diff).length > 0) {
      auditSettingsChange(this.audit, storeId, actor, 'store_preferences', storeId, {
        change: 'updated',
        fields: Object.keys(outcome.diff),
        changes: outcome.diff
      })
    }
    return outcome.after
  }
}
