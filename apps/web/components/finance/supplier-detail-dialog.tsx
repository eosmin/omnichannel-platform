'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { SupplierPaymentView, SupplierView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { moneyText } from '../../lib/finance/money'
import {
  useSupplier,
  useSupplierBalance,
  useSupplierPayments
} from '../../lib/finance/use-purchases'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import type { PaymentTarget } from './payment-dialog'

// One supplier: what is owed to it, and the payments made to it, the newest first (TDD_18 §2.7). Paying and voiding are the page's
// dialogs: this one only asks for them.
export function SupplierDetailDialog({
  supplierId,
  open,
  onOpenChange,
  onEdit,
  onPay,
  onVoid
}: {
  supplierId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (supplier: SupplierView) => void
  onPay: (target: PaymentTarget) => void
  onVoid: (payment: SupplierPaymentView) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.supplierDetail')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open && supplierId !== null ? (
          <Detail supplierId={supplierId} onEdit={onEdit} onPay={onPay} onVoid={onVoid} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Detail({
  supplierId,
  onEdit,
  onPay,
  onVoid
}: {
  supplierId: string
  onEdit: (supplier: SupplierView) => void
  onPay: (target: PaymentTarget) => void
  onVoid: (payment: SupplierPaymentView) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.supplierDetail')
  const locale = useLocale()
  const format = useFormatter()
  const { storeId, can } = useStore()
  // Paying needs the chart (the account the money leaves), which is finance:view
  const canPay = can(ClientPermissions.FINANCE_MOVE_MONEY) && can(ClientPermissions.FINANCE_VIEW)
  const supplier = useSupplier(storeId, supplierId)
  const balance = useSupplierBalance(storeId, supplierId)
  const payments = useSupplierPayments(storeId, supplierId)
  const failed = supplier.isError
    ? supplier
    : balance.isError
      ? balance
      : payments.isError
        ? payments
        : null
  if (failed !== null)
    return <LoadFailed error={failed.error} onRetry={() => void failed.refetch()} />
  if (supplier.data === undefined || balance.data === undefined || payments.data === undefined) {
    return <PageLoading />
  }
  const view = supplier.data
  const owed = balance.data
  const rows = payments.data.pages.flatMap(page => page.data)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-lg font-semibold" data-testid="supplier-detail-name">
          {view.name}
        </span>
        <span className="text-muted-foreground text-sm">
          {[view.taxId, view.contactName, view.email, view.phone]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </span>
        <span className="text-muted-foreground text-sm">
          {t('terms', { days: view.paymentTermsDays })}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="supplier-balance">
        <Figure label={t('billed')} value={moneyText(locale, owed.billedCents)} />
        <Figure label={t('paid')} value={moneyText(locale, owed.paidCents)} />
        <Figure label={t('open')} value={moneyText(locale, owed.openCents)} strong />
        <Figure label={t('overdue')} value={moneyText(locale, owed.overdueCents)} />
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => onEdit(view)}>
          {t('edit')}
        </Button>
        {canPay && owed.openCents > 0 ? (
          <Button
            type="button"
            size="sm"
            onClick={() =>
              onPay({
                supplierId: view.id,
                supplierName: view.name,
                orderId: null,
                bill: null,
                supplierOpenCents: owed.openCents
              })
            }
          >
            {t('pay')}
          </Button>
        ) : null}
      </div>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t('payments')}</h3>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noPayments')}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="supplier-payments">
            {rows.map(payment => (
              <li
                key={payment.id}
                data-testid="supplier-payment-row"
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm tabular-nums">
                    {moneyText(locale, payment.amountCents)}
                    {payment.voidedByEntryId === null ? null : (
                      <span className="bg-muted text-muted-foreground ml-2 rounded-full px-2 py-0.5 text-xs">
                        {t('voided')}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {format.dateTime(new Date(`${payment.paidOn}T00:00:00`), {
                      dateStyle: 'medium'
                    })}
                    {payment.reference === null ? '' : ` · ${payment.reference}`}
                  </span>
                </div>
                {canPay && payment.voidedByEntryId === null ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => onVoid(payment)}>
                    {t('void')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {payments.hasNextPage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={payments.isFetchingNextPage}
            onClick={() => void payments.fetchNextPage()}
          >
            {t('loadMore')}
          </Button>
        ) : null}
      </section>
    </div>
  )
}

function Figure({
  label,
  value,
  strong = false
}: {
  label: string
  value: string
  strong?: boolean
}): ReactElement {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  )
}
