import { Injectable } from '@nestjs/common'

import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import {
  readSafetySettings,
  type SafetySettings,
  type UpdateSafetySettingsBody
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import { auditSettingsChange } from './settings.support'

const SAFETY_SCOPE = 'safety'
const SAFETY_RESOURCE_TYPE = 'store_safety_settings'

// How a store asks before a destructive action of the HIGH and MODERATE tiers (TDD_09 §11.2, StoreSettings.safety).
// The column holds only what the store chose; a key it did not choose reads as the default, which is to ask. The
// tier of each action stays in DestructiveActionTiers: this lowers the friction of the tiers that are configurable
// and never touches the CRITICAL ones.
@Injectable()
export class SafetySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(storeId: string): Promise<SafetySettings> {
    const row = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { safety: true }
    })
    if (row === null) throw resourceNotFound('store settings')
    return readSafetySettings(row.safety)
  }

  async update(
    storeId: string,
    body: UpdateSafetySettingsBody,
    actor: Actor
  ): Promise<SafetySettings> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // Two writers that read the column and write it back would lose one of the changes, so they take turns
      await lockStoreScope(tx, storeId, SAFETY_SCOPE)
      const current = await tx.storeSettings.findUnique({
        where: { storeId },
        select: { safety: true }
      })
      if (current === null) throw resourceNotFound('store settings')
      const before = readSafetySettings(current.safety)
      // Merged over what is stored, key by key: a key that this version does not know stays as it is
      const stored =
        typeof current.safety === 'object' &&
        current.safety !== null &&
        !Array.isArray(current.safety)
          ? current.safety
          : {}
      const changes = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined)
      )
      const row = await tx.storeSettings.update({
        where: { storeId },
        data: { safety: { ...stored, ...changes } },
        select: { safety: true }
      })
      const after = readSafetySettings(row.safety)
      // Which keys really changed, from what to what (switches and role names, not personal data)
      const diff: Record<string, { from: unknown; to: unknown }> = {}
      for (const key of Object.keys(after) as (keyof SafetySettings)[]) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
          diff[key] = { from: before[key], to: after[key] }
        }
      }
      return { after, diff }
    })
    // A request that changes nothing leaves no entry
    if (Object.keys(outcome.diff).length > 0) {
      auditSettingsChange(this.audit, storeId, actor, SAFETY_RESOURCE_TYPE, storeId, {
        change: 'updated',
        fields: Object.keys(outcome.diff),
        changes: outcome.diff
      })
    }
    return outcome.after
  }
}
