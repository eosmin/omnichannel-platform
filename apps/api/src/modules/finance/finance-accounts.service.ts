import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  type AccountType,
  type CashKind,
  FinanceChartProblems,
  FinanceConflicts,
  FinanceLimits,
  FinanceResourceTypes
} from '@platform/core/domain'
import { ErrorCodes, resourceConflict, resourceNotFound } from '@platform/core/errors'
import { accountProblems, lockedChange, normalSideOf, parentProblem } from '@platform/core/finance'

import type { Actor } from '../tenancy'

import type { CreateAccountBody, ListAccountsQuery, UpdateAccountBody } from './finance.schemas'
import {
  codeTransaction,
  invalidChart,
  lockChart,
  lockedAccount,
  requireSettings
} from './finance.support'
import { ACCOUNT_SELECT, type AccountPage, type AccountView, accountView } from './finance.views'

interface Locked {
  id: string
  code: string
  name: string
  type: AccountType
  parentId: string | null
  isPostable: boolean
  cashKind: CashKind | null
  active: boolean
}

// The chart of accounts of the organization of the request (TDD_18 §2.3). `organizationId` comes from TenantGuard and is the
// only one read here, never one from the body or the query string (CLAUDE.md rule 2). An account with entries is never
// deleted, only switched off; its type is locked once it has entries; renaming and moving it are allowed and audited.
@Injectable()
export class FinanceAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(organizationId: string, query: ListAccountsQuery): Promise<AccountPage> {
    const rows = await this.prisma.client.ledgerAccount.findMany({
      where: {
        organizationId,
        ...(query.active === undefined ? {} : { active: query.active }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.cursor === undefined ? {} : { code: { gt: query.cursor } })
      },
      select: ACCOUNT_SELECT,
      take: query.limit + 1,
      // The order of the chart: by the accountant's numbering
      orderBy: { code: 'asc' }
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    return {
      data: page.map(accountView),
      nextCursor: hasMore ? (page.at(-1)?.code ?? null) : null,
      hasMore
    }
  }

  async get(organizationId: string, accountId: string): Promise<AccountView> {
    const row = await this.prisma.client.ledgerAccount.findFirst({
      where: { id: accountId, organizationId },
      select: ACCOUNT_SELECT
    })
    if (row === null) throw resourceNotFound('ledger account')
    return accountView(row)
  }

  async create(
    organizationId: string,
    body: CreateAccountBody,
    actor: Actor
  ): Promise<AccountView> {
    const id = await codeTransaction(() =>
      this.prisma.transaction(async tx => {
        await lockChart(tx, organizationId)
        await requireSettings(tx, organizationId)
        const count = await tx.ledgerAccount.count({ where: { organizationId } })
        if (count >= FinanceLimits.MAX_ACCOUNTS_PER_ORGANIZATION) {
          throw resourceConflict(
            `an organization holds at most ${FinanceLimits.MAX_ACCOUNTS_PER_ORGANIZATION} accounts`,
            { conflict: FinanceConflicts.ACCOUNT_LIMIT }
          )
        }
        const draft = {
          code: body.code,
          name: body.name,
          type: body.type,
          isPostable: body.isPostable ?? true,
          cashKind: body.cashKind ?? null
        }
        const problems = accountProblems(draft)
        if (problems.length > 0) throw invalidChart(problems)
        await this.checkParent(tx, organizationId, null, body.type, body.parentId ?? null)
        const created = await tx.ledgerAccount.create({
          data: {
            organizationId,
            ...draft,
            normalSide: normalSideOf(body.type),
            parentId: body.parentId ?? null
          },
          select: { id: true }
        })
        return created.id
      })
    )
    this.audit.log({
      action: AuditAction.FINANCE_ACCOUNT_CREATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.ACCOUNT,
      resourceId: id,
      metadata: { code: body.code, name: body.name, type: body.type },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, id)
  }

  async update(
    organizationId: string,
    accountId: string,
    body: UpdateAccountBody,
    actor: Actor
  ): Promise<AccountView> {
    const changes = await codeTransaction(() =>
      this.prisma.transaction(async tx => {
        await lockChart(tx, organizationId)
        const current = await this.lock(tx, organizationId, accountId)
        const next = {
          code: body.code ?? current.code,
          name: body.name ?? current.name,
          type: body.type ?? current.type,
          isPostable: body.isPostable ?? current.isPostable,
          cashKind: body.cashKind === undefined ? current.cashKind : body.cashKind
        }
        // A type that changes takes the account off its header's type: the account of a cash kind is an asset, a header only
        // groups
        const problems = accountProblems(next)
        if (problems.length > 0) throw invalidChart(problems)

        const hasEntries =
          (await tx.journalLine.findFirst({
            where: { organizationId, accountId },
            select: { id: true }
          })) !== null
        const locked = lockedChange(hasEntries, current, next)
        if (locked !== null) throw lockedAccount(locked)

        const typeChanged = next.type !== current.type
        const becomesPostable = next.isPostable && !current.isPostable
        const becomesHeader = !next.isPostable && current.isPostable
        // A header keeps its children's type and a postable account has none: what has children changes neither
        if (typeChanged || becomesPostable) {
          const children = await tx.ledgerAccount.count({
            where: { organizationId, parentId: accountId }
          })
          if (children > 0) throw invalidChart([FinanceChartProblems.HAS_CHILDREN])
        }
        // What a role, a payment method or the rounding setting points at keeps its type, its kind of cash and its place as an
        // account that takes entries: the postings that need it count on them
        const kindChanged = next.cashKind !== current.cashKind
        if (
          (becomesHeader || typeChanged || kindChanged) &&
          (await this.usedBySetting(tx, organizationId, accountId))
        ) {
          throw resourceConflict(
            'a role, a payment method or the rounding setting uses the account',
            {
              conflict: FinanceConflicts.ACCOUNT_IN_USE_BY_SETTING
            }
          )
        }
        const parentId = body.parentId === undefined ? current.parentId : body.parentId
        if (body.parentId !== undefined || typeChanged) {
          await this.checkParent(tx, organizationId, accountId, next.type, parentId)
        }

        const changed: Record<string, { from: unknown; to: unknown }> = {}
        const note = (field: string, from: unknown, to: unknown): void => {
          if (from !== to) changed[field] = { from, to }
        }
        note('code', current.code, next.code)
        note('name', current.name, next.name)
        note('type', current.type, next.type)
        note('parentId', current.parentId, parentId)
        note('isPostable', current.isPostable, next.isPostable)
        note('cashKind', current.cashKind, next.cashKind)
        if (Object.keys(changed).length === 0) return changed
        await tx.ledgerAccount.update({
          where: { id: accountId },
          data: {
            code: next.code,
            name: next.name,
            type: next.type,
            normalSide: normalSideOf(next.type),
            parentId,
            isPostable: next.isPostable,
            cashKind: next.cashKind
          }
        })
        return changed
      })
    )
    // A request that changes nothing leaves no entry
    if (Object.keys(changes).length > 0) {
      this.audit.log({
        action: AuditAction.FINANCE_ACCOUNT_UPDATED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.ACCOUNT,
        resourceId: accountId,
        metadata: { fields: Object.keys(changes), changes },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(organizationId, accountId)
  }

  // An account stops taking new entries. It stays in the chart and in every report; the entries it has stay as they are, and
  // the reversal of one of them is still allowed (TDD_18 §2.5). One that a role, a payment method or the rounding setting
  // points at is not switched off: the postings that need it would fail.
  async deactivate(organizationId: string, accountId: string, actor: Actor): Promise<AccountView> {
    const changed = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      const current = await this.lock(tx, organizationId, accountId)
      if (!current.active) return false
      if (await this.usedBySetting(tx, organizationId, accountId)) {
        throw resourceConflict(
          'a role, a payment method or the rounding setting uses the account',
          {
            conflict: FinanceConflicts.ACCOUNT_IN_USE_BY_SETTING
          }
        )
      }
      await tx.ledgerAccount.update({ where: { id: accountId }, data: { active: false } })
      return true
    })
    if (changed) {
      this.audit.log({
        action: AuditAction.FINANCE_ACCOUNT_DEACTIVATED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.ACCOUNT,
        resourceId: accountId,
        metadata: { fields: ['active'] },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(organizationId, accountId)
  }

  async reactivate(organizationId: string, accountId: string, actor: Actor): Promise<AccountView> {
    const changed = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      const current = await this.lock(tx, organizationId, accountId)
      if (current.active) return false
      await tx.ledgerAccount.update({ where: { id: accountId }, data: { active: true } })
      return true
    })
    if (changed) {
      this.audit.log({
        action: AuditAction.FINANCE_ACCOUNT_UPDATED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.ACCOUNT,
        resourceId: accountId,
        metadata: { fields: ['active'], changes: { active: { from: false, to: true } } },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(organizationId, accountId)
  }

  // The account of the organization, locked until the transaction ends. An account of another organization is an account that
  // does not exist.
  private async lock(
    tx: PrismaTransaction,
    organizationId: string,
    accountId: string
  ): Promise<Locked> {
    const rows = await tx.$queryRaw<Locked[]>`
      SELECT id, code, name, type, parent_id AS "parentId", is_postable AS "isPostable", cash_kind AS "cashKind", active
      FROM ledger_accounts WHERE id = ${accountId} AND organization_id = ${organizationId} FOR UPDATE`
    const row = rows[0]
    if (row === undefined) throw resourceNotFound('ledger account')
    return row
  }

  private async usedBySetting(
    tx: PrismaTransaction,
    organizationId: string,
    accountId: string
  ): Promise<boolean> {
    const [roles, payments, rounding] = await Promise.all([
      tx.accountRoleMapping.count({ where: { organizationId, accountId } }),
      tx.paymentMethodAccount.count({ where: { organizationId, accountId } }),
      tx.financeSettings.count({ where: { organizationId, roundingAccountId: accountId } })
    ])
    return roles + payments + rounding > 0
  }

  // The rules of a place in the chart (TDD_18 §2.3): the parent is a header of the same type of the organization, the account
  // is not put under itself, and the chart does not nest deeper than its limit
  private async checkParent(
    tx: PrismaTransaction,
    organizationId: string,
    accountId: string | null,
    type: AccountType,
    parentId: string | null
  ): Promise<void> {
    if (parentId === null) return
    const nodes = await tx.ledgerAccount.findMany({
      where: { organizationId },
      select: { id: true, parentId: true, type: true, isPostable: true }
    })
    const problem = parentProblem(
      nodes.map(node => ({ ...node, type: node.type as AccountType })),
      accountId,
      type,
      parentId
    )
    if (problem === null) return
    // A parent that is not in the organization is a parent that does not exist
    if (problem === ErrorCodes.RESOURCE_NOT_FOUND) throw resourceNotFound('ledger account')
    throw invalidChart([problem])
  }
}
