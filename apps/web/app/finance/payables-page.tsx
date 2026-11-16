'use client'

import Link from 'next/link'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useId, useMemo, useState } from 'react'

import { AppPaths, type PayableBillView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { PaymentDialog, type PaymentTarget } from '../../components/finance/payment-dialog'
import { PurchasesGate } from '../../components/finance/purchases-gate'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { moneyText } from '../../lib/finance/money'
import { dayOfDate, daysPastDue } from '../../lib/finance/purchase-form'
import { useAllSuppliers, usePayables } from '../../lib/finance/use-purchases'

// Finance → Payables (TDD_18 §2.7): every bill with something open, with its due day, and what each supplier is owed in all. A bill is
// paid from here (`finance:move_money`); the figures are the api's own.
export function PayablesPage(): ReactElement {
  return (
    <PurchasesGate
      anyOf={[ClientPermissions.FINANCE_MANAGE_PURCHASES, ClientPermissions.FINANCE_MOVE_MONEY]}
    >
      <Payables />
    </PurchasesGate>
  )
}

function Payables(): ReactElement {
  const t = useTranslations('finance.purchases.payables')
  const locale = useLocale()
  const format = useFormatter()
  const ids = useId()
  const { storeId, can } = useStore()
  const canPay = can(ClientPermissions.FINANCE_MOVE_MONEY)
  const canOpenOrders = can(ClientPermissions.FINANCE_MANAGE_PURCHASES)
  const [supplierId, setSupplierId] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [paying, setPaying] = useState<PaymentTarget | null>(null)
  const payables = usePayables(storeId, { supplierId, overdueOnly }, true)
  // The names of the suppliers come from the list of suppliers, which is for who manages purchases: a person who only pays sees the
  // bills by their document and their due day
  const suppliers = useAllSuppliers(storeId, canOpenOrders)
  const nameOf = useMemo(
    () => new Map((suppliers.data ?? []).map(supplier => [supplier.id, supplier.name])),
    [suppliers.data]
  )
  const today = dayOfDate(new Date())

  if (payables.isError) {
    return <LoadFailed error={payables.error} onRetry={() => void payables.refetch()} />
  }
  if (payables.data === undefined) return <PageLoading />
  const { bills, suppliers: totals } = payables.data
  const supplierOf = (id: string): string => nameOf.get(id) ?? t('unknownSupplier')
  const openOfSupplier = (id: string): number =>
    totals.find(total => total.supplierId === id)?.openCents ?? 0
  const payTarget = (bill: PayableBillView): PaymentTarget => ({
    supplierId: bill.supplierId,
    supplierName: supplierOf(bill.supplierId),
    orderId: bill.purchaseOrderId,
    bill: {
      receiptId: bill.receiptId,
      label: bill.supplierDocumentNumber ?? bill.receivedOn,
      openCents: bill.openCents
    },
    supplierOpenCents: openOfSupplier(bill.supplierId)
  })

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        {canOpenOrders ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-supplier`}>{t('filters.supplier')}</Label>
            <select
              id={`${ids}-supplier`}
              className={SELECT_CLASS}
              value={supplierId}
              onChange={event => setSupplierId(event.target.value)}
            >
              <option value="">{t('filters.allSuppliers')}</option>
              {(suppliers.data ?? []).map(supplier => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={event => setOverdueOnly(event.target.checked)}
          />
          {t('filters.overdueOnly')}
        </label>
      </div>
      {totals.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2" data-testid="payables-suppliers">
          {totals.map(total => (
            <li
              key={total.supplierId}
              data-testid="payables-supplier"
              className="flex flex-col gap-0.5 rounded-md border px-4 py-3"
            >
              <span className="text-sm font-medium">{supplierOf(total.supplierId)}</span>
              <span className="text-sm tabular-nums">
                {t('totals', {
                  open: moneyText(locale, total.openCents),
                  overdue: moneyText(locale, total.overdueCents)
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {bills.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="payables-bills">
          {bills.map(bill => (
            <li
              key={bill.receiptId}
              data-testid="payables-bill"
              data-overdue={bill.overdue ? 'true' : 'false'}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{supplierOf(bill.supplierId)}</span>
                  {bill.overdue ? (
                    <span className="bg-destructive/10 text-destructive rounded-full px-2 py-0.5 text-xs font-medium">
                      {t('overdueDays', { days: daysPastDue(bill.dueOn, today) })}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('billLine', {
                    document: bill.supplierDocumentNumber ?? t('noDocument'),
                    due: format.dateTime(new Date(`${bill.dueOn}T00:00:00`), {
                      dateStyle: 'medium'
                    })
                  })}
                </span>
                <span className="text-sm tabular-nums">
                  {t('open', {
                    open: moneyText(locale, bill.openCents),
                    total: moneyText(locale, bill.totalCents)
                  })}
                </span>
              </div>
              <span className="flex flex-wrap gap-1">
                {canOpenOrders ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={AppPaths.finance.purchase(bill.purchaseOrderId)}>
                      {t('openOrder')}
                    </Link>
                  </Button>
                ) : null}
                {canPay ? (
                  <Button type="button" size="sm" onClick={() => setPaying(payTarget(bill))}>
                    {t('pay')}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <PaymentDialog
        target={paying}
        open={paying !== null}
        onOpenChange={open => {
          if (!open) setPaying(null)
        }}
      />
    </section>
  )
}
