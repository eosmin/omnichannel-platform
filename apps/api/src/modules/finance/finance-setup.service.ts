import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  AccountRole,
  FinanceConflicts,
  FinanceLimits,
  FinanceResourceTypes
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict
} from '@platform/core/errors'
import {
  financeTemplateCountries,
  financeTemplateFor,
  isIsoDate,
  nextPeriod,
  normalSideOf,
  periodOfDate
} from '@platform/core/finance'

import type { Actor } from '../tenancy'

import type { SetupBody } from './finance.schemas'
import { dayDate, lockChart } from './finance.support'
import { SETTINGS_SELECT, type SetupState, settingsView } from './finance.views'

const firstOfThisMonth = (now: Date): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`

// The books of an organization start here, once (TDD_18 §3.1, §6.5): the template of the country is copied into the
// organization's own data (the chart, the account each role posts to, the account of each payment method) and from then on
// the accountant edits it. Nothing is posted: opening balances are a manual entry, written by a person.
@Injectable()
export class FinanceSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async state(organizationId: string): Promise<SetupState> {
    const row = await this.prisma.client.financeSettings.findUnique({
      where: { organizationId },
      select: SETTINGS_SELECT
    })
    return {
      ready: row !== null,
      countries: financeTemplateCountries(),
      settings: row === null ? null : settingsView(row)
    }
  }

  async setup(organizationId: string, body: SetupBody, actor: Actor): Promise<SetupState> {
    const template = financeTemplateFor(body.countryCode)
    if (template === null) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'no finance template for that country',
        HttpStatusCodes.BAD_REQUEST,
        { countryCode: body.countryCode }
      )
    }
    const start = body.accountingStartDate ?? firstOfThisMonth(new Date())
    const year = Number(start.slice(0, 4))
    // A year the calendar of the books holds, and one more month after it for the next period
    if (!isIsoDate(start) || year < FinanceLimits.MIN_YEAR || year >= FinanceLimits.MAX_YEAR) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'the start date is not a calendar date',
        HttpStatusCodes.BAD_REQUEST
      )
    }

    await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      const existing = await tx.financeSettings.findUnique({
        where: { organizationId },
        select: { organizationId: true }
      })
      if (existing !== null) {
        throw resourceConflict('the books of the organization are set up already', {
          conflict: FinanceConflicts.ALREADY_SET_UP
        })
      }
      await tx.financeSettings.create({
        data: {
          organizationId,
          countryCode: template.countryCode,
          accountingStartDate: dayDate(start)
        }
      })

      // One statement for the whole chart: a header and what sits under it are written together, and the keys that tie them are
      // checked when the statement ends
      const idOf = new Map(template.accounts.map(account => [account.code, randomUUID()]))
      const accountId = (code: string): string => {
        const id = idOf.get(code)
        if (id === undefined)
          throw new Error(`the template names the account ${code}, which it does not have`)
        return id
      }
      await tx.ledgerAccount.createMany({
        data: template.accounts.map(account => ({
          id: accountId(account.code),
          organizationId,
          code: account.code,
          name: account.name,
          type: account.type,
          normalSide: normalSideOf(account.type),
          parentId: account.parentCode === null ? null : accountId(account.parentCode),
          isPostable: account.isPostable,
          cashKind: account.cashKind ?? null,
          isSystem: true
        }))
      })
      await tx.accountRoleMapping.createMany({
        data: Object.values(AccountRole).map(role => ({
          organizationId,
          role,
          accountId: accountId(template.roles[role])
        }))
      })
      await tx.paymentMethodAccount.createMany({
        data: Object.entries(template.paymentMethods).map(([paymentMethod, code]) => ({
          organizationId,
          storeId: null,
          paymentMethod,
          accountId: accountId(code)
        }))
      })
      await tx.financeSettings.update({
        where: { organizationId },
        data: { roundingAccountId: accountId(template.roles[AccountRole.ROUNDING]) }
      })
      // The period of the start date and the next one are there before anything needs them
      const first = periodOfDate(start)
      const second = nextPeriod(first)
      await tx.fiscalPeriod.createMany({
        data: [first, second].map(bounds => ({
          organizationId,
          year: bounds.year,
          month: bounds.month,
          startsOn: dayDate(bounds.startsOn),
          endsOn: dayDate(bounds.endsOn)
        })),
        skipDuplicates: true
      })
    })

    this.audit.log({
      action: AuditAction.FINANCE_SETUP_COMPLETED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.SETTINGS,
      resourceId: organizationId,
      metadata: { countryCode: template.countryCode, accountingStartDate: start },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.state(organizationId)
  }
}
