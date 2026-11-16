'use client'

import { Plus } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useId, useMemo, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { PurchaseOrderStatus } from '@platform/core/domain'

import { NewPurchaseDialog } from '../../components/finance/new-purchase-dialog'
import { PurchaseStatusBadge } from '../../components/finance/purchase-status-badge'
import { PurchasesGate } from '../../components/finance/purchases-gate'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { useAllSuppliers, usePurchaseOrderPages } from '../../lib/finance/use-purchases'

// Finance → Purchases (TDD_18 §2.7): the orders to suppliers, newest first, by status and by supplier. A purchase order is the page that
// holds its lines, what arrived and what was paid.
export function PurchasesPage(): ReactElement {
  return (
    <PurchasesGate anyOf={[ClientPermissions.FINANCE_MANAGE_PURCHASES]}>
      <Purchases />
    </PurchasesGate>
  )
}

function Purchases(): ReactElement {
  const t = useTranslations('finance.purchases.orders')
  const tStatus = useTranslations('finance.purchases.status')
  const format = useFormatter()
  const ids = useId()
  const { storeId } = useStore()
  const [status, setStatus] = useState<PurchaseOrderStatus | ''>('')
  const [supplierId, setSupplierId] = useState('')
  const [creating, setCreating] = useState(false)
  const list = usePurchaseOrderPages(storeId, { status, supplierId }, true)
  const suppliers = useAllSuppliers(storeId, true)
  const nameOf = useMemo(
    () => new Map((suppliers.data ?? []).map(supplier => [supplier.id, supplier.name])),
    [suppliers.data]
  )

  if (list.isError) return <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
  if (list.data === undefined) return <PageLoading />
  const rows = list.data.pages.flatMap(page => page.data)

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
      <div className="flex flex-wrap gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-status`}>{t('filters.status')}</Label>
          <select
            id={`${ids}-status`}
            className={SELECT_CLASS}
            value={status}
            onChange={event => setStatus(event.target.value as PurchaseOrderStatus | '')}
          >
            <option value="">{t('filters.allStatuses')}</option>
            {Object.values(PurchaseOrderStatus).map(value => (
              <option key={value} value={value}>
                {tStatus(value)}
              </option>
            ))}
          </select>
        </div>
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
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="finance-purchase-orders">
          {rows.map(order => (
            <li
              key={order.id}
              data-testid="finance-purchase-row"
              data-number={order.number}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{order.number}</span>
                  <PurchaseStatusBadge status={order.status} />
                </span>
                <span className="text-muted-foreground text-sm">
                  {nameOf.get(order.supplierId) ?? t('unknownSupplier')}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('summary', {
                    lines: order.lines.length,
                    date: format.dateTime(new Date(order.createdAt), { dateStyle: 'medium' })
                  })}
                </span>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={AppPaths.finance.purchase(order.id)}>{t('open')}</Link>
              </Button>
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
      <NewPurchaseDialog open={creating} onOpenChange={setCreating} />
    </section>
  )
}
