import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { FinanceResourceTypes } from '@platform/core/domain'
import { ErrorCodes, resourceNotFound } from '@platform/core/errors'
import { periodBounds } from '@platform/core/finance'
import { financeRefusal } from '@platform/core/finance-ledger'

import type { Actor } from '../tenancy'

import type { ListPeriodsQuery, OpenPeriodBody } from './finance.schemas'
import { dayDate, organizationDay } from './finance.support'
import {
  isoDay,
  PERIOD_SELECT,
  type PeriodPage,
  type PeriodView,
  periodView
} from './finance.views'

// The fiscal periods of the organization (TDD_18 §2.4): calendar months, made when something needs them. Closing and reopening
// one is Step 4B.8's; here a period is listed and opened ahead of the first entry that would make it anyway.
@Injectable()
export class FinancePeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(organizationId: string, query: ListPeriodsQuery): Promise<PeriodPage> {
    const cursor =
      query.cursor === undefined
        ? null
        : { year: Number(query.cursor.slice(0, 4)), month: Number(query.cursor.slice(5, 7)) }
    const rows = await this.prisma.client.fiscalPeriod.findMany({
      where: {
        organizationId,
        // The newest first: what is older than the last period of the previous page
        ...(cursor === null
          ? {}
          : {
              OR: [
                { year: { lt: cursor.year } },
                { year: cursor.year, month: { lt: cursor.month } }
              ]
            })
      },
      select: PERIOD_SELECT,
      take: query.limit + 1,
      orderBy: [{ year: 'desc' }, { month: 'desc' }]
    })
    const today = await organizationDay(this.prisma.client, organizationId, new Date())
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => periodView(row, today)),
      nextCursor:
        hasMore && last !== undefined
          ? `${last.year}-${String(last.month).padStart(2, '0')}`
          : null,
      hasMore
    }
  }

  async get(organizationId: string, periodId: string): Promise<PeriodView> {
    const row = await this.prisma.client.fiscalPeriod.findFirst({
      where: { id: periodId, organizationId },
      select: PERIOD_SELECT
    })
    if (row === null) throw resourceNotFound('fiscal period')
    return periodView(row, await organizationDay(this.prisma.client, organizationId, new Date()))
  }

  // The period of a month, made if it is not there yet. Asking twice answers the same period.
  async open(organizationId: string, body: OpenPeriodBody, actor: Actor): Promise<PeriodView> {
    const bounds = periodBounds(body.year, body.month)
    const { id, created } = await this.prisma.transaction(async tx => {
      const settings = await tx.financeSettings.findUnique({
        where: { organizationId },
        select: { accountingStartDate: true }
      })
      if (settings === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
      // The books start on a day: a month that ended before it is not a period of them
      if (bounds.endsOn < isoDay(settings.accountingStartDate)) {
        throw financeRefusal(ErrorCodes.FINANCE_BEFORE_START_DATE)
      }
      // `skipDuplicates` answers how many rows THIS call inserted: two opens of the same month at once both see it missing, but only one
      // inserts it, and only that one is the open that is audited (HC-211)
      const { count } = await tx.fiscalPeriod.createMany({
        data: [
          {
            organizationId,
            year: bounds.year,
            month: bounds.month,
            startsOn: dayDate(bounds.startsOn),
            endsOn: dayDate(bounds.endsOn)
          }
        ],
        skipDuplicates: true
      })
      const period = await tx.fiscalPeriod.findUniqueOrThrow({
        where: {
          organizationId_year_month: { organizationId, year: bounds.year, month: bounds.month }
        },
        select: { id: true }
      })
      return { id: period.id, created: count > 0 }
    })
    if (created) {
      this.audit.log({
        action: AuditAction.FINANCE_PERIOD_OPENED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.PERIOD,
        resourceId: id,
        metadata: { year: bounds.year, month: bounds.month },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(organizationId, id)
  }
}
