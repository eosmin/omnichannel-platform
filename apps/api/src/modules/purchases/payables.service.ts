import { Injectable } from '@nestjs/common'

import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'
import { type BillBalance, billBalances, dateToDay } from '@platform/core/finance'

import { organizationDay } from '../finance/finance.support'

import type { PayablesQuery } from './purchases.schemas'
import { daysPastDue } from './purchases.support'
import type { PayableBillView, PayablesView, SupplierBalanceView } from './purchases.views'

type Reader = Pick<
  PrismaTransaction,
  'purchaseReceipt' | 'supplierPayment' | 'supplierPaymentReturn' | 'store'
>

// What is owed to the suppliers (TDD_18 §2.7): bills (the receipts) minus the live payments, with the due day of each bill. The
// open balance of a supplier is exactly bills - payments, however the payments were named: a payment that names no bill is applied to
// the oldest due first (`billBalances`). What a supplier gave back of a payment (a live return) is taken from what that payment paid, on the
// same bill or in the same unapplied part, so the debt is owed again. Read from the operational rows; the ledger's payable account (party = the supplier) holds the
// same sums, and the reconciliation of Step 4B.6 compares the two.
@Injectable()
export class PayablesService {
  constructor(private readonly prisma: PrismaService) {}

  async payables(organizationId: string, query: PayablesQuery): Promise<PayablesView> {
    const { bills, suppliers } = await this.compute(
      this.prisma.client,
      organizationId,
      query.supplierId ?? null
    )
    return {
      bills: bills
        .filter(bill => bill.openCents > 0 && (!query.overdueOnly || bill.overdue))
        .map(billView),
      suppliers: suppliers.filter(
        balance => balance.openCents > 0 || query.supplierId !== undefined
      )
    }
  }

  async balance(organizationId: string, supplierId: string): Promise<SupplierBalanceView> {
    const supplier = await this.prisma.client.supplier.findFirst({
      where: { id: supplierId, organizationId },
      select: { id: true }
    })
    if (supplier === null) throw resourceNotFound('supplier')
    const { suppliers } = await this.compute(this.prisma.client, organizationId, supplierId)
    return (
      suppliers[0] ?? { supplierId, billedCents: 0, paidCents: 0, openCents: 0, overdueCents: 0 }
    )
  }

  // What the supplier owes at this moment, read inside the transaction that checks a payment against it (the supplier is locked there)
  async openBalance(
    db: Reader,
    organizationId: string,
    supplierId: string
  ): Promise<{ supplier: SupplierBalanceView; bills: Bill[] }> {
    const { bills, suppliers } = await this.compute(db, organizationId, supplierId)
    return {
      supplier: suppliers[0] ?? {
        supplierId,
        billedCents: 0,
        paidCents: 0,
        openCents: 0,
        overdueCents: 0
      },
      bills
    }
  }

  private async compute(
    db: Reader,
    organizationId: string,
    supplierId: string | null
  ): Promise<{ bills: Bill[]; suppliers: SupplierBalanceView[] }> {
    const [receipts, payments, returns, day] = await Promise.all([
      db.purchaseReceipt.findMany({
        where: { organizationId, ...(supplierId === null ? {} : { supplierId }) },
        select: {
          id: true,
          purchaseOrderId: true,
          supplierId: true,
          supplierDocumentNumber: true,
          receivedOn: true,
          dueOn: true,
          totalCents: true
        }
      }),
      db.supplierPayment.groupBy({
        by: ['supplierId', 'purchaseReceiptId'],
        where: {
          organizationId,
          voidedByEntryId: null,
          ...(supplierId === null ? {} : { supplierId })
        },
        _sum: { amountCents: true }
      }),
      // What the suppliers gave back and nobody voided, by the bill the payment named (or none)
      db.supplierPaymentReturn.findMany({
        where: {
          organizationId,
          voidedByEntryId: null,
          ...(supplierId === null ? {} : { supplierId })
        },
        select: {
          amountCents: true,
          supplierId: true,
          payment: { select: { purchaseReceiptId: true } }
        }
      }),
      // "Overdue" is against the day of the books (the store furthest behind), like the close: the browser clock decides nothing
      organizationDay(db, organizationId, new Date())
    ])
    const paidOnBill = new Map<string, number>()
    const unapplied = new Map<string, number>()
    const paidBySupplier = new Map<string, number>()
    for (const group of payments) {
      const amount = group._sum.amountCents ?? 0
      paidBySupplier.set(group.supplierId, (paidBySupplier.get(group.supplierId) ?? 0) + amount)
      if (group.purchaseReceiptId === null) {
        unapplied.set(group.supplierId, (unapplied.get(group.supplierId) ?? 0) + amount)
      } else {
        paidOnBill.set(group.purchaseReceiptId, amount)
      }
    }
    for (const given of returns) {
      const receiptId = given.payment.purchaseReceiptId
      paidBySupplier.set(
        given.supplierId,
        (paidBySupplier.get(given.supplierId) ?? 0) - given.amountCents
      )
      if (receiptId === null) {
        unapplied.set(given.supplierId, (unapplied.get(given.supplierId) ?? 0) - given.amountCents)
      } else {
        paidOnBill.set(receiptId, (paidOnBill.get(receiptId) ?? 0) - given.amountCents)
      }
    }
    const facts = new Map(receipts.map(receipt => [receipt.id, receipt]))
    const bills = billBalances(
      receipts.map(receipt => ({
        id: receipt.id,
        supplierId: receipt.supplierId,
        dueOn: dateToDay(receipt.dueOn),
        totalCents: receipt.totalCents,
        paidCents: paidOnBill.get(receipt.id) ?? 0
      })),
      unapplied,
      day
    )
    const balances = new Map<string, SupplierBalanceView>()
    const touched = new Set([...receipts.map(r => r.supplierId), ...paidBySupplier.keys()])
    for (const id of touched) {
      balances.set(id, {
        supplierId: id,
        billedCents: 0,
        paidCents: paidBySupplier.get(id) ?? 0,
        openCents: 0,
        overdueCents: 0
      })
    }
    for (const receipt of receipts) {
      const balance = balances.get(receipt.supplierId)
      if (balance !== undefined) balance.billedCents += receipt.totalCents
    }
    for (const bill of bills) {
      const balance = balances.get(bill.supplierId)
      if (balance === undefined) continue
      balance.openCents += bill.openCents
      if (bill.overdue) balance.overdueCents += bill.openCents
    }
    // `bills` is sorted by due day; keep that order, and add what the list needs of the receipt
    return {
      bills: bills.map(bill => {
        const receipt = facts.get(bill.id)
        return {
          ...bill,
          daysOverdue: bill.overdue ? daysPastDue(bill.dueOn, day) : 0,
          purchaseOrderId: receipt?.purchaseOrderId ?? '',
          supplierDocumentNumber: receipt?.supplierDocumentNumber ?? null,
          receivedOn: receipt === undefined ? '' : dateToDay(receipt.receivedOn)
        }
      }),
      suppliers: [...balances.values()].sort((a, b) => a.supplierId.localeCompare(b.supplierId))
    }
  }
}

interface Bill extends BillBalance {
  daysOverdue: number
  purchaseOrderId: string
  supplierDocumentNumber: string | null
  receivedOn: string
}

function billView(bill: Bill): PayableBillView {
  return {
    receiptId: bill.id,
    purchaseOrderId: bill.purchaseOrderId,
    supplierId: bill.supplierId,
    supplierDocumentNumber: bill.supplierDocumentNumber,
    receivedOn: bill.receivedOn,
    dueOn: bill.dueOn,
    totalCents: bill.totalCents,
    openCents: bill.openCents,
    overdue: bill.overdue,
    daysOverdue: bill.daysOverdue
  }
}
