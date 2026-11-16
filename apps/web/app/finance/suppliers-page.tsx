'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useDeferredValue, useId, useState } from 'react'

import type { SupplierPaymentView, SupplierView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { PaymentDialog, type PaymentTarget } from '../../components/finance/payment-dialog'
import { PurchasesGate } from '../../components/finance/purchases-gate'
import { ReasonDialog } from '../../components/finance/reason-dialog'
import { SupplierDetailDialog } from '../../components/finance/supplier-detail-dialog'
import { SupplierDialog } from '../../components/finance/supplier-dialog'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useFinanceAccounts } from '../../lib/finance/use-finance'
import { useSupplierPages, useVoidSupplierPayment } from '../../lib/finance/use-purchases'
import { toast } from '../../lib/toast'

// Finance → Suppliers (TDD_18 §2.7): who the business buys from, with the terms of each and what is owed. Everything here is
// `finance:manage_purchases`; a payment is `finance:move_money` too. The api checks both on every call.
export function SuppliersPage(): ReactElement {
  return (
    <PurchasesGate anyOf={[ClientPermissions.FINANCE_MANAGE_PURCHASES]}>
      <Suppliers />
    </PurchasesGate>
  )
}

function Suppliers(): ReactElement {
  const t = useTranslations('finance.purchases.suppliers')
  const tDetail = useTranslations('finance.purchases.supplierDetail')
  const ids = useId()
  const { storeId, can } = useStore()
  const [text, setText] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const q = useDeferredValue(text.trim())
  const list = useSupplierPages(storeId, { q, includeInactive }, true)
  const accounts = useFinanceAccounts(storeId, can(ClientPermissions.FINANCE_VIEW))
  const voidPayment = useVoidSupplierPayment(storeId)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SupplierView | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [paying, setPaying] = useState<PaymentTarget | null>(null)
  const [voiding, setVoiding] = useState<SupplierPaymentView | null>(null)

  if (list.isError) return <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
  if (list.data === undefined) return <PageLoading />
  const rows = list.data.pages.flatMap(page => page.data)
  const chart = can(ClientPermissions.FINANCE_VIEW) ? (accounts.data ?? []) : null

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          {t('new')}
        </Button>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-48 flex-1 gap-1.5">
          <Label htmlFor={`${ids}-search`}>{t('search')}</Label>
          <Input
            id={`${ids}-search`}
            value={text}
            autoComplete="off"
            onChange={event => setText(event.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={event => setIncludeInactive(event.target.checked)}
          />
          {t('includeInactive')}
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{q === '' ? t('empty') : t('noMatch')}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="finance-suppliers">
          {rows.map(supplier => (
            <li
              key={supplier.id}
              data-testid="finance-supplier-row"
              data-name={supplier.name}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{supplier.name}</span>
                  {supplier.active ? null : (
                    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
                      {t('inactive')}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">
                  {[supplier.taxId, supplier.contactName, supplier.email, supplier.phone]
                    .filter((part): part is string => part !== null)
                    .join(' · ')}
                </span>
                <span className="text-muted-foreground text-xs">
                  {tDetail('terms', { days: supplier.paymentTermsDays })}
                </span>
              </div>
              <span className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setDetailId(supplier.id)}
                >
                  {t('details')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(supplier)}
                >
                  {t('edit')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
      <SupplierDialog supplier={null} accounts={chart} open={creating} onOpenChange={setCreating} />
      <SupplierDialog
        supplier={editing}
        accounts={chart}
        open={editing !== null}
        onOpenChange={open => {
          if (!open) setEditing(null)
        }}
      />
      <SupplierDetailDialog
        supplierId={detailId}
        open={detailId !== null}
        onOpenChange={open => {
          if (!open) setDetailId(null)
        }}
        onEdit={supplier => setEditing(supplier)}
        onPay={setPaying}
        onVoid={setVoiding}
      />
      <PaymentDialog
        target={paying}
        open={paying !== null}
        onOpenChange={open => {
          if (!open) setPaying(null)
        }}
      />
      <VoidPaymentDialog
        payment={voiding}
        onClose={() => setVoiding(null)}
        voidPayment={voidPayment}
      />
    </section>
  )
}

function VoidPaymentDialog({
  payment,
  onClose,
  voidPayment
}: {
  payment: SupplierPaymentView | null
  onClose: () => void
  voidPayment: ReturnType<typeof useVoidSupplierPayment>
}): ReactElement {
  const t = useTranslations('finance.purchases.voidPayment')
  return (
    <ReasonDialog
      open={payment !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      required
      action="VOID_SUPPLIER_PAYMENT"
      copy={{
        title: t('title'),
        description: t('description'),
        label: t('reason'),
        submit: t('submit'),
        confirm: {
          title: t('confirmTitle'),
          description: t('confirmDescription'),
          confirmLabel: t('confirm')
        }
      }}
      onSubmit={async reason => {
        if (payment === null) return
        await voidPayment.mutateAsync({ id: payment.id, input: { reason } })
        toast.success(t('done'))
      }}
    />
  )
}
