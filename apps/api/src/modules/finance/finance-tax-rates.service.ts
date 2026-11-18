import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AccountType,
  FinanceConflicts,
  FinanceResourceTypes,
  FinanceTaxLimits
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { CreateTaxRateBody, UpdateTaxRateBody } from './finance.schemas'
import {
  lockChart,
  lockSettingsRow,
  netBalanceCents,
  requireSettings,
  usableAccount
} from './finance.support'
import { TAX_RATE_SELECT, type TaxRateView, taxRateView } from './finance.views'

const conflict = (message: string, kind: string) => resourceConflict(message, { conflict: kind })

// The unique index of the code is what holds when two requests ask for the same code at the same moment
async function codeTransaction<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(
        'a tax rate of the organization already has that code',
        FinanceConflicts.TAX_RATE_CODE_IN_USE
      )
    }
    throw error
  }
}

// The tax rates of the organization (TDD_18 §7). A rate is data the accountant edits: its basis points, its accounts and which
// one is the default. A rate that an order, a product or an entry names is never deleted, only switched off, and changing a
// rate moves the orders made after the change and none that exists (their tax is a snapshot). Every change is audited with what
// it was and what it is.
@Injectable()
export class FinanceTaxRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(organizationId: string): Promise<TaxRateView[]> {
    const rows = await this.prisma.client.taxRate.findMany({
      where: { organizationId },
      select: TAX_RATE_SELECT,
      orderBy: [{ code: 'asc' }, { id: 'asc' }]
    })
    return rows.map(taxRateView)
  }

  async create(
    organizationId: string,
    body: CreateTaxRateBody,
    actor: Actor
  ): Promise<TaxRateView> {
    const created = await codeTransaction(() =>
      this.prisma.transaction(async tx => {
        await lockChart(tx, organizationId)
        await requireSettings(tx, organizationId)
        const count = await tx.taxRate.count({ where: { organizationId } })
        if (count >= FinanceTaxLimits.MAX_TAX_RATES_PER_ORGANIZATION) {
          throw conflict(
            'the organization has the most tax rates it can have',
            FinanceConflicts.TAX_RATE_LIMIT
          )
        }
        await this.assertAccounts(tx, organizationId, body.outputAccountId, body.inputAccountId)
        if (body.isDefault === true) await this.clearDefault(tx, organizationId)
        return tx.taxRate.create({
          data: {
            organizationId,
            code: body.code,
            name: body.name,
            rateBps: body.rateBps,
            outputAccountId: body.outputAccountId,
            inputAccountId: body.inputAccountId,
            isDefault: body.isDefault === true
          },
          select: TAX_RATE_SELECT
        })
      })
    )
    this.log(organizationId, actor, created.id, {
      change: 'created',
      code: created.code,
      rateBps: created.rateBps,
      isDefault: created.isDefault
    })
    return taxRateView(created)
  }

  async update(
    organizationId: string,
    id: string,
    body: UpdateTaxRateBody,
    actor: Actor
  ): Promise<TaxRateView> {
    const outcome = await codeTransaction(() =>
      this.prisma.transaction(async tx => {
        await lockChart(tx, organizationId)
        const current = await this.lock(tx, organizationId, id)
        const changed: Record<string, { from: unknown; to: unknown }> = {}
        const data: Record<string, unknown> = {}
        for (const field of ['code', 'name', 'rateBps'] as const) {
          const next = body[field]
          if (next !== undefined && next !== current[field]) {
            changed[field] = { from: current[field], to: next }
            data[field] = next
          }
        }
        for (const field of ['outputAccountId', 'inputAccountId'] as const) {
          const next = body[field]
          if (next !== undefined && next !== current[field]) {
            changed[field] = { from: current[field], to: next }
            data[field] = next
          }
        }
        if (data['outputAccountId'] !== undefined || data['inputAccountId'] !== undefined) {
          await this.assertAccounts(
            tx,
            organizationId,
            body.outputAccountId ?? current.outputAccountId,
            body.inputAccountId ?? current.inputAccountId
          )
          // The tax already posted stays where it was: the purchases and the entries by hand read the accounts of the rate, so a move
          // with tax on them splits it. Once it nets to zero (a reversal, a reclassification) the rate moves (HC-119)
          await lockSettingsRow(tx, organizationId)
          if ((await netBalanceCents(tx, organizationId, { taxRateId: id })) !== 0) {
            throw conflict(
              'the tax rate holds posted tax',
              FinanceConflicts.TAX_RATE_ACCOUNT_HAS_HISTORY
            )
          }
        }
        if (body.isDefault === true && !current.isDefault) {
          // A switched-off rate cannot be the default: it would tax nothing
          if (!current.active) {
            throw conflict('the tax rate is switched off', FinanceConflicts.TAX_RATE_INACTIVE)
          }
          await this.clearDefault(tx, organizationId)
          changed['isDefault'] = { from: false, to: true }
          data['isDefault'] = true
        }
        if (Object.keys(changed).length === 0) return { changed, row: current }
        const row = await tx.taxRate.update({
          where: { id },
          data,
          select: TAX_RATE_SELECT
        })
        return { changed, row }
      })
    )
    if (Object.keys(outcome.changed).length > 0) {
      this.log(organizationId, actor, id, {
        change: 'updated',
        fields: Object.keys(outcome.changed),
        changes: outcome.changed
      })
    }
    return taxRateView(outcome.row)
  }

  async deactivate(organizationId: string, id: string, actor: Actor): Promise<TaxRateView> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      const current = await this.lock(tx, organizationId, id)
      if (!current.active) return { row: current, changed: false }
      // The default rate is what a taxed product that names none is taxed at: another is chosen first
      if (current.isDefault) {
        throw conflict(
          'the default tax rate cannot be switched off',
          FinanceConflicts.TAX_RATE_IS_DEFAULT
        )
      }
      // The row is locked for update above and a product names a rate under a share lock on it, so the count cannot be outrun
      // An archived product counts too: it could be switched on again with a rate that is off
      const products = await tx.product.count({ where: { taxRateId: id } })
      if (products > 0) {
        throw resourceConflict('a product names the tax rate', {
          conflict: FinanceConflicts.TAX_RATE_IN_USE_BY_PRODUCT,
          products
        })
      }
      const row = await tx.taxRate.update({
        where: { id },
        data: { active: false },
        select: TAX_RATE_SELECT
      })
      return { row, changed: true }
    })
    if (outcome.changed) this.log(organizationId, actor, id, { change: 'deactivated' })
    return taxRateView(outcome.row)
  }

  async reactivate(organizationId: string, id: string, actor: Actor): Promise<TaxRateView> {
    const outcome = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      const current = await this.lock(tx, organizationId, id)
      if (current.active) return { row: current, changed: false }
      // The accounts may have gone off since the rate did: a rate that is on posts to accounts that take the tax
      await this.assertAccounts(tx, organizationId, current.outputAccountId, current.inputAccountId)
      const row = await tx.taxRate.update({
        where: { id },
        data: { active: true },
        select: TAX_RATE_SELECT
      })
      return { row, changed: true }
    })
    if (outcome.changed) this.log(organizationId, actor, id, { change: 'reactivated' })
    return taxRateView(outcome.row)
  }

  // The rate of the organization, locked for update until the transaction ends; one of another organization does not exist
  private async lock(tx: PrismaTransaction, organizationId: string, id: string) {
    await tx.$queryRaw`SELECT 1 AS locked FROM tax_rates WHERE id = ${id} AND organization_id = ${organizationId} FOR UPDATE`
    const row = await tx.taxRate.findFirst({
      where: { id, organizationId },
      select: TAX_RATE_SELECT
    })
    if (row === null) throw resourceNotFound('tax rate')
    return row
  }

  // The tax owed is a liability and the tax to credit is an asset, and they are not the same account: another account would put
  // the VAT in the wrong place of every entry that names the rate
  private async assertAccounts(
    tx: PrismaTransaction,
    organizationId: string,
    outputAccountId: string,
    inputAccountId: string
  ): Promise<void> {
    await usableAccount(tx, organizationId, outputAccountId)
    await usableAccount(tx, organizationId, inputAccountId)
    const rows = await tx.ledgerAccount.findMany({
      where: { organizationId, id: { in: [outputAccountId, inputAccountId] } },
      select: { id: true, type: true }
    })
    const typeOf = (id: string): string | undefined => rows.find(row => row.id === id)?.type
    if (
      outputAccountId === inputAccountId ||
      typeOf(outputAccountId) !== (AccountType.LIABILITY as string) ||
      typeOf(inputAccountId) !== (AccountType.ASSET as string)
    ) {
      throw conflict(
        'the output account must be a liability and the input account an asset, and not the same',
        FinanceConflicts.TAX_RATE_ACCOUNT_TYPE
      )
    }
  }

  private async clearDefault(tx: PrismaTransaction, organizationId: string): Promise<void> {
    await tx.taxRate.updateMany({
      where: { organizationId, isDefault: true },
      data: { isDefault: false }
    })
  }

  private log(
    organizationId: string,
    actor: Actor,
    id: string,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action: AuditAction.FINANCE_TAX_RATE_CHANGED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.TAX_RATE,
      resourceId: id,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
