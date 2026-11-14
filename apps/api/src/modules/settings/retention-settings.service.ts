import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  RetentionDefaults,
  RetentionResourceTypes,
  type RetentionField
} from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { PutRetentionSettingsBody } from './settings.schemas'

export type RetentionSettingsView = Record<RetentionField, number>

const RETENTION_SELECT = {
  conversationDays: true,
  mediaDays: true,
  analyticsDays: true,
  notificationDays: true
} as const

// How long a store keeps its conversations, files, analytics events and read notifications (TDD_05 §10.4). The
// nightly run of the worker reads these windows; the row is made with the store, and a store that has none is
// read as the factory defaults until the first save writes it. The effective window is this row only (the v1.2
// MVP has no plans).
@Injectable()
export class RetentionSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(storeId: string): Promise<RetentionSettingsView> {
    const row = await this.prisma.client.retentionSettings.findUnique({
      where: { storeId },
      select: RETENTION_SELECT
    })
    return row ?? { ...RetentionDefaults }
  }

  async put(
    storeId: string,
    body: PutRetentionSettingsBody,
    actor: Actor
  ): Promise<RetentionSettingsView> {
    const outcome = await this.prisma.transaction(async tx => {
      const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true } })
      if (store === null) throw resourceNotFound('store')
      // Two saves take turns, so each entry of the audit has the true "from". A row that is not there yet is made first
      // (ON CONFLICT: two first saves make one, the Prisma upsert would answer the loser with an error), then locked
      await tx.$executeRaw`
        INSERT INTO retention_settings (store_id, updated_at) VALUES (${storeId}, now())
        ON CONFLICT (store_id) DO NOTHING`
      await tx.$queryRaw`SELECT store_id FROM retention_settings WHERE store_id = ${storeId} FOR UPDATE`
      const before = await tx.retentionSettings.findUniqueOrThrow({
        where: { storeId },
        select: RETENTION_SELECT
      })
      const after = await tx.retentionSettings.update({
        where: { storeId },
        data: body,
        select: RETENTION_SELECT
      })
      const changes: Record<string, { from: number; to: number }> = {}
      for (const key of Object.keys(after) as RetentionField[]) {
        if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] }
      }
      return { after, changes }
    })
    // A save that changes nothing leaves no entry. What is shortened deletes data the night after, so every change is audited
    if (Object.keys(outcome.changes).length > 0) {
      this.audit.log({
        action: AuditAction.RETENTION_CHANGED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: RetentionResourceTypes.RETENTION_SETTINGS,
        resourceId: storeId,
        metadata: { fields: Object.keys(outcome.changes), changes: outcome.changes },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return outcome.after
  }
}
