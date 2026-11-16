'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import { AppPaths, type PurchaseReceiptView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { TaxRounding } from '@platform/core/domain'

import { OrderLinesEditor } from '../../components/finance/order-lines-editor'
import { PaymentDialog, type PaymentTarget } from '../../components/finance/payment-dialog'
import { PurchaseStatusBadge } from '../../components/finance/purchase-status-badge'
import { PurchasesGate } from '../../components/finance/purchases-gate'
import { ReasonDialog } from '../../components/finance/reason-dialog'
import { ReceiveDialog } from '../../components/finance/receive-dialog'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { moneyText, percentOfBps } from '../../lib/finance/money'
import {
  moneyOfLines,
  type OrderAction,
  OrderActions,
  orderActionsOf
} from '../../lib/finance/purchase-form'
import { useFinanceSettings, useFinanceTaxRates } from '../../lib/finance/use-finance'
import { useLineLabels } from '../../lib/finance/use-line-labels'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import {
  useAllSuppliers,
  useCancelPurchaseOrder,
  useClosePurchaseOrder,
  useOrderPurchaseOrder,
  usePayables,
  usePurchaseOrder,
  usePurchaseOrderPayments
} from '../../lib/finance/use-purchases'
import { useWarehousesOfStore } from '../../lib/inventory/use-inventory'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'

// One purchase order (TDD_18 §2.7): the screen is the step it is at. A draft has its lines edited and is marked ordered; an ordered one is
// received (in as many deliveries as needed), closed short or cancelled; what arrived is a bill, and a bill is paid here or from the
// payables. Reading and changing it is `finance:manage_purchases`; a payment is `finance:move_money` too.
export function PurchaseOrderPage(): ReactElement {
  return (
    <PurchasesGate anyOf={[ClientPermissions.FINANCE_MANAGE_PURCHASES]}>
      <PurchaseOrder />
    </PurchasesGate>
  )
}

function PurchaseOrder(): ReactElement {
  const params = useParams<{ id: string }>()
  const id = params.id
  const t = useTranslations('finance.purchases.order')
  const locale = useLocale()
  const format = useFormatter()
  const errorText = usePurchaseErrorText()
  const { storeId, can } = useStore()
  const canReadBooks = can(ClientPermissions.FINANCE_VIEW)
  // Paying needs the chart (the account the money leaves), which is finance:view
  const canPay = can(ClientPermissions.FINANCE_MOVE_MONEY) && canReadBooks
  const order = usePurchaseOrder(storeId, id, true)
  const suppliers = useAllSuppliers(storeId, true)
  const warehouses = useWarehousesOfStore(storeId, true)
  const taxRates = useFinanceTaxRates(storeId, canReadBooks)
  const settings = useFinanceSettings(storeId, canReadBooks)
  const payments = usePurchaseOrderPayments(storeId, id, true)
  const markOrdered = useOrderPurchaseOrder(storeId)
  const closeOrder = useClosePurchaseOrder(storeId)
  const cancelOrder = useCancelPurchaseOrder(storeId)
  const guard = useSubmitGuard()
  const [dirty, setDirty] = useState(false)
  const [receiving, setReceiving] = useState(false)
  const [closing, setClosing] = useState<'close' | 'cancel' | null>(null)
  const [paying, setPaying] = useState<PaymentTarget | null>(null)
  const labels = useLineLabels(storeId, order.data?.lines ?? [])

  const rates = canReadBooks ? (taxRates.data ?? null) : null
  const rounding =
    canReadBooks && settings.data !== undefined ? roundingOf(settings.data.taxRounding) : null
  const rateOf = useMemo(() => new Map((rates ?? []).map(rate => [rate.id, rate])), [rates])
  // What is still open on each bill is the api's own figure (the payables), never a sum made here over a page of payments
  const payables = usePayables(
    storeId,
    { supplierId: order.data?.supplierId ?? '', overdueOnly: false },
    order.data !== undefined
  )
  const openOf = useMemo(
    () => new Map((payables.data?.bills ?? []).map(bill => [bill.receiptId, bill.openCents])),
    [payables.data]
  )

  const failed = order.isError
    ? order
    : payments.isError
      ? payments
      : payables.isError
        ? payables
        : null
  if (failed !== null) {
    return <LoadFailed error={failed.error} onRetry={() => void failed.refetch()} />
  }
  if (order.data === undefined || payments.data === undefined || payables.data === undefined) {
    return <PageLoading />
  }
  const view = order.data
  const supplierName =
    (suppliers.data ?? []).find(supplier => supplier.id === view.supplierId)?.name ??
    t('unknownSupplier')
  const warehouseName =
    (warehouses.data ?? []).find(warehouse => warehouse.id === view.warehouseId)?.name ??
    t('unknownWarehouse')
  const actions = orderActionsOf(view)
  const has = (action: OrderAction): boolean => actions.includes(action)
  const money = moneyOfLines(
    view.lines.map(line => ({
      quantity: line.quantity,
      unitCostCents: line.unitCostCents,
      taxRateId: line.taxRateId
    })),
    rateId => rateOf.get(rateId)?.rateBps ?? null,
    rounding ?? TaxRounding.HALF_UP
  )
  const taxKnown = rates !== null && rounding !== null

  const billTarget = (bill: PurchaseReceiptView, openCents: number): PaymentTarget => ({
    supplierId: view.supplierId,
    supplierName,
    orderId: view.id,
    bill: {
      receiptId: bill.id,
      label: bill.supplierDocumentNumber ?? bill.receivedOn,
      openCents
    },
    supplierOpenCents: openCents
  })

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={AppPaths.finance.purchases}>
          <ArrowLeft aria-hidden />
          {t('back')}
        </Link>
      </Button>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold" data-testid="purchase-number">
            {view.number}
          </h1>
          <PurchaseStatusBadge status={view.status} />
        </div>
        <p className="text-muted-foreground text-sm">
          {t('summary', { supplier: supplierName, warehouse: warehouseName })}
        </p>
        <p className="text-muted-foreground text-xs">
          {view.orderedOn === null ? t('notOrdered') : t('orderedOn', { date: view.orderedOn })}
          {view.expectedOn === null ? '' : ` · ${t('expectedOn', { date: view.expectedOn })}`}
        </p>
        {view.notes === null ? null : <p className="text-sm">{view.notes}</p>}
      </header>
      <div className="flex flex-wrap gap-2">
        {has(OrderActions.ORDER) ? (
          <Button
            type="button"
            size="sm"
            disabled={markOrdered.isPending || dirty || view.lines.length === 0}
            onClick={() => {
              if (!guard.enter()) return
              markOrdered.mutate(view.id, {
                onSuccess: () => toast.success(t('markedOrdered')),
                onError: error => toast.error(errorText(error)),
                onSettled: guard.leave
              })
            }}
          >
            {t('markOrdered')}
          </Button>
        ) : null}
        {has(OrderActions.RECEIVE) ? (
          <Button type="button" size="sm" onClick={() => setReceiving(true)}>
            {t('receive')}
          </Button>
        ) : null}
        {has(OrderActions.CLOSE) ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setClosing('close')}>
            {t('close')}
          </Button>
        ) : null}
        {has(OrderActions.CANCEL) ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setClosing('cancel')}>
            {t('cancel')}
          </Button>
        ) : null}
      </div>
      {has(OrderActions.EDIT) ? (
        <OrderLinesEditor
          // Saving makes new line ids: the editor starts again from what was saved, with the names of the new lines
          key={view.lines.map(line => line.id).join(',')}
          order={view}
          labels={labels}
          taxRates={rates}
          rounding={rounding}
          onDirty={setDirty}
        />
      ) : (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-medium">{t('linesTitle')}</h2>
          <ul className="divide-y rounded-md border" data-testid="order-lines">
            {view.lines.map(line => (
              <li
                key={line.id}
                data-testid="order-line"
                className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-sm font-medium">
                  {labels.get(line.id) ?? line.productId.slice(0, 8)}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {t('lineDetail', {
                    received: line.receivedQuantity,
                    ordered: line.quantity,
                    cost: moneyText(locale, line.unitCostCents),
                    tax:
                      line.taxRateId === null
                        ? t('noTax')
                        : t('percent', {
                            percent: percentOfBps(rateOf.get(line.taxRateId)?.rateBps ?? 0)
                          })
                  })}
                </span>
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-3 gap-3 text-sm" data-testid="order-totals">
            <div className="flex flex-col">
              <dt className="text-muted-foreground text-xs">{t('subtotal')}</dt>
              <dd className="tabular-nums">{moneyText(locale, money.subtotalCents)}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground text-xs">{t('tax')}</dt>
              <dd className="tabular-nums">
                {taxKnown ? moneyText(locale, money.taxCents) : t('taxUnknown')}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground text-xs">{t('total')}</dt>
              <dd className="font-semibold tabular-nums">
                {taxKnown ? moneyText(locale, money.totalCents) : t('taxUnknown')}
              </dd>
            </div>
          </dl>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">{t('billsTitle')}</h2>
        {view.receipts.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noBills')}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="order-bills">
            {view.receipts.map(bill => {
              const open = openOf.get(bill.id) ?? 0
              return (
                <li
                  key={bill.id}
                  data-testid="order-bill"
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {bill.supplierDocumentNumber ?? t('noDocument')}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t('billDates', {
                        received: format.dateTime(new Date(`${bill.receivedOn}T00:00:00`), {
                          dateStyle: 'medium'
                        }),
                        due: format.dateTime(new Date(`${bill.dueOn}T00:00:00`), {
                          dateStyle: 'medium'
                        })
                      })}
                    </span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {t('billMoney', {
                        subtotal: moneyText(locale, bill.subtotalCents),
                        tax: moneyText(locale, bill.taxCents),
                        total: moneyText(locale, bill.totalCents),
                        open: moneyText(locale, open)
                      })}
                      {bill.taxCreditable ? '' : ` · ${t('taxNotCredited')}`}
                    </span>
                  </div>
                  {canPay && open > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setPaying(billTarget(bill, open))}
                    >
                      {t('pay')}
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">{t('paymentsTitle')}</h2>
        {payments.data.pages.every(page => page.data.length === 0) ? (
          <p className="text-muted-foreground text-sm">{t('noPayments')}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="order-payments">
            {payments.data.pages
              .flatMap(page => page.data)
              .map(payment => (
                <li
                  key={payment.id}
                  data-testid="order-payment"
                  className="flex flex-col gap-0.5 px-4 py-2"
                >
                  <span className="text-sm tabular-nums">
                    {moneyText(locale, payment.amountCents)}
                    {payment.voidedByEntryId === null ? '' : ` · ${t('voided')}`}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {payment.paidOn}
                    {payment.reference === null ? '' : ` · ${payment.reference}`}
                  </span>
                </li>
              ))}
          </ul>
        )}
        {payments.hasNextPage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            disabled={payments.isFetchingNextPage}
            onClick={() => void payments.fetchNextPage()}
          >
            {t('loadMore')}
          </Button>
        ) : null}
      </section>
      <ReceiveDialog
        order={view}
        labels={labels}
        taxRates={rates}
        rounding={rounding}
        open={receiving}
        onOpenChange={setReceiving}
      />
      <PaymentDialog
        target={paying}
        open={paying !== null}
        onOpenChange={open => {
          if (!open) setPaying(null)
        }}
      />
      <CloseOrCancelDialog
        kind={closing}
        number={view.number}
        onClose={() => setClosing(null)}
        onSubmit={async (kind, reason) => {
          const input = reason === '' ? {} : { reason }
          if (kind === 'close') await closeOrder.mutateAsync({ id: view.id, input })
          else await cancelOrder.mutateAsync({ id: view.id, input })
          toast.success(kind === 'close' ? t('closed') : t('cancelled'))
        }}
      />
    </section>
  )
}

// The rule the organization rounds tax by, or null for a text this page does not know (never a guess)
function roundingOf(text: string): TaxRounding | null {
  return Object.values(TaxRounding).find(value => String(value) === text) ?? null
}

function CloseOrCancelDialog({
  kind,
  number,
  onClose,
  onSubmit
}: {
  kind: 'close' | 'cancel' | null
  number: string
  onClose: () => void
  onSubmit: (kind: 'close' | 'cancel', reason: string) => Promise<void>
}): ReactElement {
  const t = useTranslations('finance.purchases.closeOrder')
  // The words of the last one asked stay while the box fades out
  const [last, setLast] = useState<'close' | 'cancel'>('close')
  if (kind !== null && kind !== last) setLast(kind)
  const which = kind ?? last
  return (
    <ReasonDialog
      open={kind !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
      required={false}
      copy={{
        title: t(`${which}.title`, { number }),
        description: t(`${which}.description`),
        label: t('reason'),
        submit: t(`${which}.submit`)
      }}
      onSubmit={reason => onSubmit(which, reason)}
    />
  )
}
