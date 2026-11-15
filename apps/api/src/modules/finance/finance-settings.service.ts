import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { AccountRole, FinanceConflicts, FinanceResourceTypes } from '@platform/core/domain'
import { ErrorCodes, resourceConflict, resourceNotFound } from '@platform/core/errors'
import { financeRefusal } from '@platform/core/finance-ledger'

import type { Actor } from '../tenancy'

import type { MapRoleBody, SetPaymentAccountBody, UpdateSettingsBody } from './finance.schemas'
import { lockChart, requireSettings, usableAccount } from './finance.support'
import {
  type PaymentAccountView,
  type RoleMappingView,
  SETTINGS_SELECT,
  type SettingsView,
  settingsView
} from './finance.views'

// The settings of the books and the two maps that say where an automatic entry posts (TDD_18 §2.3, §6.2): which account each
// role means and where each payment method's money lands. Every change is audited with what it was and what it is.
@Injectable()
export class FinanceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async get(organizationId: string): Promise<SettingsView> {
    const row = await this.prisma.client.financeSettings.findUnique({
      where: { organizationId },
      select: SETTINGS_SELECT
    })
    if (row === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
    return settingsView(row)
  }

  async update(
    organizationId: string,
    body: UpdateSettingsBody,
    actor: Actor
  ): Promise<SettingsView> {
    const changes = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      const current = await tx.financeSettings.findUnique({
        where: { organizationId },
        select: {
          recognizeSaleOn: true,
          roundingAccountId: true,
          taxRounding: true,
          shippingTaxed: true
        }
      })
      if (current === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
      const changed: Record<string, { from: unknown; to: unknown }> = {}
      if (
        body.recognizeSaleOn !== undefined &&
        (body.recognizeSaleOn as string) !== current.recognizeSaleOn
      ) {
        changed['recognizeSaleOn'] = { from: current.recognizeSaleOn, to: body.recognizeSaleOn }
      }
      if (
        body.roundingAccountId !== undefined &&
        body.roundingAccountId !== current.roundingAccountId
      ) {
        await usableAccount(tx, organizationId, body.roundingAccountId)
        // The rounding account is the account of the ROUNDING role too: one source of truth, kept in step from both ends
        await tx.accountRoleMapping.upsert({
          where: { organizationId_role: { organizationId, role: AccountRole.ROUNDING } },
          create: { organizationId, role: AccountRole.ROUNDING, accountId: body.roundingAccountId },
          update: { accountId: body.roundingAccountId }
        })
        changed['roundingAccountId'] = {
          from: current.roundingAccountId,
          to: body.roundingAccountId
        }
      }
      // How a fraction of a cent of tax is placed and whether the shipping fee carries the tax: read when an order is made, so a
      // change moves the orders made after it and never rewrites one that exists (their tax is a snapshot, TDD_18 §7)
      if (body.taxRounding !== undefined && (body.taxRounding as string) !== current.taxRounding) {
        changed['taxRounding'] = { from: current.taxRounding, to: body.taxRounding }
      }
      if (body.shippingTaxed !== undefined && body.shippingTaxed !== current.shippingTaxed) {
        changed['shippingTaxed'] = { from: current.shippingTaxed, to: body.shippingTaxed }
      }
      if (Object.keys(changed).length === 0) return changed
      await tx.financeSettings.update({
        where: { organizationId },
        data: {
          ...(body.recognizeSaleOn === undefined ? {} : { recognizeSaleOn: body.recognizeSaleOn }),
          ...(body.taxRounding === undefined ? {} : { taxRounding: body.taxRounding }),
          ...(body.shippingTaxed === undefined ? {} : { shippingTaxed: body.shippingTaxed }),
          ...(body.roundingAccountId === undefined
            ? {}
            : { roundingAccountId: body.roundingAccountId })
        }
      })
      return changed
    })
    if (Object.keys(changes).length > 0) {
      this.audit.log({
        action: AuditAction.FINANCE_SETTINGS_CHANGED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.SETTINGS,
        resourceId: organizationId,
        metadata: { fields: Object.keys(changes), changes },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(organizationId)
  }

  async roles(organizationId: string): Promise<RoleMappingView[]> {
    const rows = await this.prisma.client.accountRoleMapping.findMany({
      where: { organizationId },
      select: { role: true, accountId: true },
      orderBy: { role: 'asc' }
    })
    return rows
  }

  async mapRole(
    organizationId: string,
    role: string,
    body: MapRoleBody,
    actor: Actor
  ): Promise<RoleMappingView> {
    const before = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      await requireSettings(tx, organizationId)
      await usableAccount(tx, organizationId, body.accountId)
      const current = await tx.accountRoleMapping.findUnique({
        where: { organizationId_role: { organizationId, role } },
        select: { accountId: true }
      })
      await tx.accountRoleMapping.upsert({
        where: { organizationId_role: { organizationId, role } },
        create: { organizationId, role, accountId: body.accountId },
        update: { accountId: body.accountId }
      })
      if (role === (AccountRole.ROUNDING as string)) {
        await tx.financeSettings.update({
          where: { organizationId },
          data: { roundingAccountId: body.accountId }
        })
      }
      return current?.accountId ?? null
    })
    if (before !== body.accountId) {
      this.audit.log({
        action: AuditAction.FINANCE_ROLE_MAPPED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.ROLE_MAPPING,
        resourceId: role,
        metadata: { role, from: before, to: body.accountId },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return { role, accountId: body.accountId }
  }

  async paymentAccounts(organizationId: string): Promise<PaymentAccountView[]> {
    return this.prisma.client.paymentMethodAccount.findMany({
      where: { organizationId },
      select: { id: true, paymentMethod: true, storeId: true, accountId: true },
      orderBy: [{ paymentMethod: 'asc' }, { id: 'asc' }]
    })
  }

  // The account a payment method lands in, for the organization or for one store (TDD_18 §6.2)
  async setPaymentAccount(
    organizationId: string,
    body: SetPaymentAccountBody,
    actor: Actor
  ): Promise<PaymentAccountView> {
    const storeId = body.storeId ?? null
    const { view, before } = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      await requireSettings(tx, organizationId)
      if (storeId !== null) {
        // A store of another organization is a store that does not exist
        const store = await tx.store.count({ where: { id: storeId, organizationId } })
        if (store === 0) throw resourceNotFound('store')
      }
      await usableAccount(tx, organizationId, body.accountId)
      const current = await tx.paymentMethodAccount.findFirst({
        where: { organizationId, storeId, paymentMethod: body.paymentMethod },
        select: { id: true, accountId: true }
      })
      const select = { id: true, paymentMethod: true, storeId: true, accountId: true } as const
      const row =
        current === null
          ? await tx.paymentMethodAccount.create({
              data: {
                organizationId,
                storeId,
                paymentMethod: body.paymentMethod,
                accountId: body.accountId
              },
              select
            })
          : await tx.paymentMethodAccount.update({
              where: { id: current.id },
              data: { accountId: body.accountId },
              select
            })
      return { view: row, before: current?.accountId ?? null }
    })
    if (before !== body.accountId) {
      this.audit.log({
        action: AuditAction.FINANCE_PAYMENT_ACCOUNT_CHANGED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.PAYMENT_ACCOUNT,
        resourceId: view.id,
        metadata: {
          paymentMethod: body.paymentMethod,
          forStoreId: storeId,
          from: before,
          to: body.accountId
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return view
  }

  // Takes a store's own choice away, so that the default of the organization applies again. The default itself stays: a payment
  // method with no account would make its sales fail to post.
  async removePaymentAccount(
    organizationId: string,
    paymentAccountId: string,
    actor: Actor
  ): Promise<void> {
    const removed = await this.prisma.transaction(async tx => {
      await lockChart(tx, organizationId)
      const row = await tx.paymentMethodAccount.findFirst({
        where: { id: paymentAccountId, organizationId },
        select: { id: true, storeId: true, paymentMethod: true, accountId: true }
      })
      if (row === null) throw resourceNotFound('payment account')
      if (row.storeId === null) {
        throw resourceConflict('the default account of a payment method stays', {
          conflict: FinanceConflicts.DEFAULT_PAYMENT_ACCOUNT
        })
      }
      await tx.paymentMethodAccount.delete({ where: { id: row.id } })
      return row
    })
    this.audit.log({
      action: AuditAction.FINANCE_PAYMENT_ACCOUNT_CHANGED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.PAYMENT_ACCOUNT,
      resourceId: removed.id,
      metadata: {
        paymentMethod: removed.paymentMethod,
        forStoreId: removed.storeId,
        from: removed.accountId,
        to: null
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
