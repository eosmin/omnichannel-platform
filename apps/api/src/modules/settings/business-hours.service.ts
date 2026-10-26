import { Injectable } from '@nestjs/common'

import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import { type PutBusinessHoursBody, weekScheduleSchema } from './settings.schemas'
import { auditSettingsChange, lockSnippet, lockStoreScope } from './settings.support'

export type BusinessHoursView = PutBusinessHoursBody

// The schedule column is Json: it is parsed again on the way out, because the database is a boundary
// like any other
function view(row: {
  timezone: string
  schedule: unknown
  awayMessageSnippetId: string | null
}): BusinessHoursView {
  return {
    timezone: row.timezone,
    schedule: weekScheduleSchema.parse(row.schedule),
    awayMessageSnippetId: row.awayMessageSnippetId
  }
}

const HOURS_SELECT = { timezone: true, schedule: true, awayMessageSnippetId: true } as const

// When the store answers: one schedule per store. A store that never set one has none, which is not
// the same as one that is always closed.
@Injectable()
export class BusinessHoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(storeId: string): Promise<BusinessHoursView> {
    const row = await this.prisma.client.businessHours.findUnique({
      where: { storeId },
      select: HOURS_SELECT
    })
    if (row === null) throw resourceNotFound('business hours')
    return view(row)
  }

  // The whole schedule is replaced: the client sends the week it shows
  async put(storeId: string, body: PutBusinessHoursBody, actor: Actor): Promise<BusinessHoursView> {
    const row = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The first PUT inserts: two of them together take turns instead of racing on the key
      await lockStoreScope(tx, storeId, 'business_hours')
      if (body.awayMessageSnippetId !== null) {
        await lockSnippet(tx, storeId, body.awayMessageSnippetId, 'reference')
      }
      return tx.businessHours.upsert({
        where: { storeId },
        create: { storeId, ...body },
        update: body,
        select: HOURS_SELECT
      })
    })
    auditSettingsChange(this.audit, storeId, actor, 'business_hours', storeId, {
      change: 'replaced',
      timezone: body.timezone
    })
    return view(row)
  }
}
