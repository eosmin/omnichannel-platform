'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { SupplierPaymentReturnView, SupplierPaymentView } from '@platform/api-client'

import { moneyText } from '../../lib/finance/money'
import { useSupplierPaymentReturns, useVoidPaymentReturn } from '../../lib/finance/use-purchases'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { LoadFailed } from '../settings/states'
import { Button } from '../ui/button'

import { PaymentReturnDialog } from './payment-return-dialog'
import { ReasonDialog } from './reason-dialog'

// The returns of one payment (what the supplier gave back, TDD_18 §4.2 E11b): shown when the person opens them, so a list of payments
// asks for nothing it does not show. A payment with returns alive is not voided: its returns are voided first (the api says so too).
export function PaymentReturns({
  payment,
  canMoveMoney
}: {
  payment: SupplierPaymentView
  canMoveMoney: boolean
}): ReactElement {
  const t = useTranslations('finance.purchases.paymentReturns')
  const locale = useLocale()
  const format = useFormatter()
  const { storeId } = useStore()
  const [open, setOpen] = useState(false)
  const [recording, setRecording] = useState(false)
  const [voiding, setVoiding] = useState<SupplierPaymentReturnView | null>(null)
  const returns = useSupplierPaymentReturns(storeId, payment.id, open)
  const voidReturn = useVoidPaymentReturn(storeId)
  const rows = returns.data?.pages.flatMap(page => page.data) ?? []
  const Chevron = open ? ChevronDown : ChevronRight
  const voided = payment.voidedByEntryId !== null

  return (
    <div className="flex w-full flex-col gap-2" data-testid="payment-returns">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          data-testid="payment-returns-toggle"
          onClick={() => setOpen(current => !current)}
        >
          <Chevron aria-hidden />
          {t('toggle')}
        </Button>
        {canMoveMoney && !voided ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="payment-return-record"
            onClick={() => setRecording(true)}
          >
            {t('record')}
          </Button>
        ) : null}
      </div>
      {open ? (
        returns.isError && returns.data === undefined ? (
          <LoadFailed error={returns.error} onRetry={() => void returns.refetch()} />
        ) : returns.data === undefined ? (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('none')}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="payment-returns-list">
            {rows.map(row => (
              <li
                key={row.id}
                data-testid="payment-return-row"
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm tabular-nums">
                    {moneyText(locale, row.amountCents)}
                    {row.voidedByEntryId === null ? null : (
                      <span className="bg-muted text-muted-foreground ml-2 rounded-full px-2 py-0.5 text-xs">
                        {t('voided')}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground text-xs break-words">
                    {format.dateTime(new Date(`${row.returnedOn}T00:00:00`), {
                      dateStyle: 'medium'
                    })}
                    {row.reference === null ? '' : ` · ${row.reference}`}
                  </span>
                </div>
                {canMoveMoney && row.voidedByEntryId === null ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => setVoiding(row)}>
                    {t('void')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
      {open && returns.hasNextPage ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={returns.isFetchingNextPage}
          onClick={() => void returns.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
      <PaymentReturnDialog payment={payment} open={recording} onOpenChange={setRecording} />
      <ReasonDialog
        open={voiding !== null}
        onOpenChange={next => {
          if (!next) setVoiding(null)
        }}
        required
        action="VOID_SUPPLIER_PAYMENT_RETURN"
        copy={{
          title: t('voidTitle'),
          description: t('voidDescription'),
          label: t('voidReason'),
          submit: t('voidSubmit'),
          confirm: {
            title: t('voidConfirmTitle'),
            description: t('voidConfirmDescription'),
            confirmLabel: t('voidConfirm')
          }
        }}
        onSubmit={async reason => {
          if (voiding === null) return
          await voidReturn.mutateAsync({ id: voiding.id, input: { reason } })
          toast.success(t('voidDone'))
        }}
      />
    </div>
  )
}
