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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

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
      // Merged over what is stored, key by key: a key this version does not know stays as it is, and the
      // `orders` block is merged by its own keys, so a page that sends one of them cannot reset the rest
      const base = asRecord(current.preferences)
      const { orders: orderChanges, ...flatChanges } = body
      const changes: JsonObject = Object.fromEntries(
        Object.entries(flatChanges).filter(([, value]) => value !== undefined)
      )
      if (orderChanges !== undefined) {
        changes['orders'] = {
          ...asRecord(base['orders']),
          ...(Object.fromEntries(
            Object.entries(orderChanges).filter(([, value]) => value !== undefined)
          ) as JsonObject)
        }
      }
      const before = readStorePreferences(base)
      const row = await tx.storeSettings.update({
        where: { storeId },
        data: { preferences: { ...base, ...changes } },
        select: { preferences: true }
      })
      const after = readStorePreferences(row.preferences)
      // Which keys really changed, from what to what (switches and the reason list, not personal data); the
      // keys of the `orders` block are named `orders.<key>`
      const diff: Record<string, { from: unknown; to: unknown }> = {}
      const beforeFlat = flatten(before)
      const afterFlat = flatten(after)
      for (const key of Object.keys(afterFlat)) {
        if (JSON.stringify(beforeFlat[key]) !== JSON.stringify(afterFlat[key])) {
          diff[key] = { from: auditedValue(beforeFlat[key]), to: auditedValue(afterFlat[key]) }
        }
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

function asRecord(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

// The preferences as one level of keys, `orders.<key>` for the keys of the orders block
function flatten(preferences: StorePreferences): Record<string, unknown> {
  const { orders, ...flat } = preferences
  return {
    ...flat,
    ...Object.fromEntries(Object.entries(orders).map(([key, value]) => [`orders.${key}`, value]))
  }
}

// The audit keeps switches as they are; a list of reasons (up to 30 entries of free text) is kept as its ids, so a row
// stays small and the text of the store is not copied into the log
function auditedValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : entry
  )
}
