import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AccountType,
  PurchaseConflicts,
  PurchaseLimits,
  PurchaseResourceTypes
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { PurchaseRule } from '@platform/core/finance'

import { encodeCursor } from '../customers/list-cursor'
import { lockScope, usableAccount } from '../finance/finance.support'
import type { Actor } from '../tenancy'

import type {
  CreateSupplierBody,
  ListSuppliersQuery,
  UpdateSupplierBody
} from './purchases.schemas'
import { invalidPurchase } from './purchases.support'
import {
  SUPPLIER_SELECT,
  type SupplierPage,
  type SupplierRow,
  type SupplierView,
  supplierView
} from './purchases.views'

const nameInUse = (): PlatformException =>
  resourceConflict('a supplier of the organization already has that name', {
    conflict: PurchaseConflicts.SUPPLIER_NAME_IN_USE
  })

// Who the organization buys from (TDD_18 §2.7). Organization-scoped: the organization is the guard's, never the body's. A supplier is
// never deleted (its bills and payments name it): it is switched off, which only stops new orders.
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(organizationId: string, query: ListSuppliersQuery): Promise<SupplierPage> {
    const { cursor } = query
    const rows = await this.prisma.client.supplier.findMany({
      where: {
        organizationId,
        ...(query.includeInactive ? {} : { active: true }),
        ...(query.q === undefined ? {} : { name: { contains: query.q, mode: 'insensitive' } }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: SUPPLIER_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(supplierView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(organizationId: string, id: string): Promise<SupplierView> {
    const row = await this.prisma.client.supplier.findFirst({
      where: { id, organizationId },
      select: SUPPLIER_SELECT
    })
    if (row === null) throw resourceNotFound('supplier')
    return supplierView(row)
  }

  async create(
    organizationId: string,
    body: CreateSupplierBody,
    actor: Actor
  ): Promise<SupplierView> {
    const created = await this.guarded(() =>
      this.prisma.transaction(async tx => {
        // The count that holds the limit and the name that two requests could both take are decided under this lock
        await lockScope(tx, `${organizationId}:suppliers`)
        const count = await tx.supplier.count({ where: { organizationId } })
        if (count >= PurchaseLimits.MAX_SUPPLIERS_PER_ORGANIZATION) {
          throw resourceConflict('the organization has the most suppliers it may have', {
            conflict: PurchaseConflicts.SUPPLIER_LIMIT
          })
        }
        await this.requireFreeName(tx, organizationId, body.name, null)
        if (body.defaultPayableAccountId !== undefined) {
          await this.requirePayableAccount(tx, organizationId, body.defaultPayableAccountId)
        }
        return tx.supplier.create({
          data: {
            organizationId,
            name: body.name,
            taxId: body.taxId ?? null,
            contactName: body.contactName ?? null,
            email: body.email ?? null,
            phone: body.phone ?? null,
            paymentTermsDays: body.paymentTermsDays,
            defaultPayableAccountId: body.defaultPayableAccountId ?? null
          },
          select: SUPPLIER_SELECT
        })
      })
    )
    this.audit.log({
      action: AuditAction.SUPPLIER_CREATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: PurchaseResourceTypes.SUPPLIER,
      resourceId: created.id,
      metadata: { paymentTermsDays: created.paymentTermsDays },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return supplierView(created)
  }

  async update(
    organizationId: string,
    id: string,
    body: UpdateSupplierBody,
    actor: Actor
  ): Promise<SupplierView> {
    const result = await this.guarded(() =>
      this.prisma.transaction(async tx => {
        await lockScope(tx, `${organizationId}:suppliers`)
        // A receipt and a payment hold this lock too: the history this checks is the one they leave, never one half way
        await lockScope(tx, `${organizationId}:supplier:${id}`)
        const current = await tx.supplier.findFirst({
          where: { id, organizationId },
          select: SUPPLIER_SELECT
        })
        if (current === null) throw resourceNotFound('supplier')
        if (body.name !== undefined) {
          await this.requireFreeName(tx, organizationId, body.name, id)
        }
        // The payable account is fixed once the supplier has a bill or a payment: its payments would post to another account than its bills
        if (
          body.defaultPayableAccountId !== undefined &&
          body.defaultPayableAccountId !== current.defaultPayableAccountId
        ) {
          if (body.defaultPayableAccountId !== null) {
            await this.requirePayableAccount(tx, organizationId, body.defaultPayableAccountId)
          }
          const [receipts, payments] = await Promise.all([
            tx.purchaseReceipt.count({ where: { organizationId, supplierId: id } }),
            tx.supplierPayment.count({ where: { organizationId, supplierId: id } })
          ])
          if (receipts + payments > 0) {
            throw new PlatformException(
              ErrorCodes.SUPPLIER_HAS_HISTORY,
              'a supplier with bills or payments keeps its payable account',
              HttpStatusCodes.CONFLICT,
              { conflict: PurchaseConflicts.SUPPLIER_PAYABLE_ACCOUNT_LOCKED }
            )
          }
        }
        const updated = await tx.supplier.update({
          where: { id },
          data: {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.taxId === undefined ? {} : { taxId: body.taxId }),
            ...(body.contactName === undefined ? {} : { contactName: body.contactName }),
            ...(body.email === undefined ? {} : { email: body.email }),
            ...(body.phone === undefined ? {} : { phone: body.phone }),
            ...(body.paymentTermsDays === undefined
              ? {}
              : { paymentTermsDays: body.paymentTermsDays }),
            ...(body.defaultPayableAccountId === undefined
              ? {}
              : { defaultPayableAccountId: body.defaultPayableAccountId }),
            ...(body.active === undefined ? {} : { active: body.active })
          },
          select: SUPPLIER_SELECT
        })
        return { updated, before: current }
      })
    )
    this.audit.log({
      action: AuditAction.SUPPLIER_UPDATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: PurchaseResourceTypes.SUPPLIER,
      resourceId: id,
      // The fields that changed, never the values of a contact
      metadata: { changed: Object.keys(body), active: result.updated.active },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return supplierView(result.updated)
  }

  // The unique index of the name (ignoring case) is the last word when two requests race; this is the typed answer
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isUniqueViolation(error)) throw nameInUse()
      throw error
    }
  }

  private async requireFreeName(
    tx: PrismaTransaction,
    organizationId: string,
    name: string,
    exceptId: string | null
  ): Promise<void> {
    const taken: Pick<SupplierRow, 'id'> | null = await tx.supplier.findFirst({
      where: {
        organizationId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } })
      },
      select: { id: true }
    })
    if (taken !== null) throw nameInUse()
  }

  // The account of what is owed to a supplier is a liability that takes entries and is on
  private async requirePayableAccount(
    tx: PrismaTransaction,
    organizationId: string,
    accountId: string
  ): Promise<void> {
    await usableAccount(tx, organizationId, accountId)
    const account = await tx.ledgerAccount.findFirst({
      where: { id: accountId, organizationId },
      select: { type: true }
    })
    if (account?.type !== AccountType.LIABILITY) {
      throw invalidPurchase([PurchaseRule.PAYABLE_ACCOUNT_TYPE])
    }
  }
}
