import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { AuditService } from '@platform/core/audit-module'
import { CacheKeys, CacheNamespaces, CacheScopes, CacheTTL } from '@platform/core/cache'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { CacheService } from '@platform/core/redis'
import {
  readStorePreferences,
  type StorePreferences,
  type UpdateStorePreferencesBody
} from '@platform/core/store-preferences'

import type { Actor } from '../tenancy'

import { auditSettingsChange } from './settings.support'

// What is cached is the column as the store wrote it, and the defaults are applied on every read: the schema of the
// preferences repairs a bad value with a default (`catch`), so used as the check of the cache it would pass a damaged
// entry off as a hit
const storedPreferencesSchema = z.record(z.string(), z.unknown())

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

// What a store may change without a deploy (StoreSettings.preferences). The column holds only what the
// store chose; what it did not choose reads as the factory default of `storePreferencesSchema`.
@Injectable()
export class PreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly cache: CacheService
  ) {}

  // Cached for CacheTTL.MEDIUM and dropped by the cache invalidation listener when a store changes them. A store with no
  // settings row is a failure of the loader, which is never cached
  async get(storeId: string): Promise<StorePreferences> {
    const stored = await this.cache.getOrSet({
      namespace: CacheNamespaces.STORE_PREFERENCES,
      key: CacheKeys.store.preferences(storeId),
      ttlSeconds: CacheTTL.MEDIUM,
      schema: storedPreferencesSchema,
      scopes: [CacheScopes.storePreferences(storeId)],
      load: async () => {
        const row = await this.prisma.client.storeSettings.findUnique({
          where: { storeId },
          select: { preferences: true }
        })
        if (row === null) throw resourceNotFound('store settings')
        return asRecord(row.preferences)
      }
    })
    return readStorePreferences(stored)
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
      const {
        orders: orderChanges,
        returns: returnChanges,
        remittances: remittanceChanges,
        ...flatChanges
      } = body
      const changes: JsonObject = Object.fromEntries(
        Object.entries(flatChanges).filter(([, value]) => value !== undefined)
      )
      for (const [block, blockChanges] of [
        ['orders', orderChanges],
        ['returns', returnChanges],
        ['remittances', remittanceChanges]
      ] as const) {
        if (blockChanges === undefined) continue
        changes[block] = {
          ...asRecord(base[block]),
          ...Object.fromEntries(
            Object.entries(blockChanges).filter(([, value]) => value !== undefined)
          )
        }
      }
      const before = readStorePreferences(base)
      const row = await tx.storeSettings.update({
        where: { storeId },
        data: { preferences: { ...base, ...changes } },
        select: { preferences: true }
      })
      const after = readStorePreferences(row.preferences)
      this.events.publish(tx, Events.STORE_SETTINGS_UPDATED, { storeId })
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

// The one writer of the preferences column also writes the key that the finance routes own (`finance.pricesIncludeTax`, TDD_18
// §7): the route checks the permission of the accountant and this method takes the same locks and publishes the same event as a
// change of any other key, so the cache of the store is dropped. Answers what the key was and what it is.
export async function writeFinancePricesIncludeTax(
  prisma: PrismaService,
  events: DomainEvents,
  storeId: string,
  pricesIncludeTax: boolean
): Promise<{ from: boolean; to: boolean }> {
  return prisma.transaction(async tx => {
    await lockStoreForWrite(tx, storeId)
    await lockStoreScope(tx, storeId, 'preferences')
    const current = await tx.storeSettings.findUnique({
      where: { storeId },
      select: { preferences: true }
    })
    if (current === null) throw resourceNotFound('store settings')
    const base = asRecord(current.preferences)
    const from = readStorePreferences(base).finance.pricesIncludeTax
    if (from === pricesIncludeTax) return { from, to: from }
    await tx.storeSettings.update({
      where: { storeId },
      data: {
        preferences: { ...base, finance: { ...asRecord(base['finance']), pricesIncludeTax } }
      }
    })
    events.publish(tx, Events.STORE_SETTINGS_UPDATED, { storeId })
    return { from, to: pricesIncludeTax }
  })
}

function asRecord(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

// The preferences as one level of keys, `orders.<key>`, `returns.<key>`, `remittances.<key>` and `finance.<key>` for the keys of the blocks
function flatten(preferences: StorePreferences): Record<string, unknown> {
  const { orders, returns, remittances, finance, ...flat } = preferences
  return {
    ...flat,
    ...Object.fromEntries(Object.entries(returns).map(([key, value]) => [`returns.${key}`, value])),
    ...Object.fromEntries(Object.entries(orders).map(([key, value]) => [`orders.${key}`, value])),
    ...Object.fromEntries(
      Object.entries(remittances).map(([key, value]) => [`remittances.${key}`, value])
    ),
    ...Object.fromEntries(Object.entries(finance).map(([key, value]) => [`finance.${key}`, value]))
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
