'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { PriceApprovalStatus } from '@platform/core/domain'

import { canEditField } from '../../lib/orders/order-detail-rules'
import { buildUpdate, draftFromOrder, type EditDraft } from '../../lib/orders/order-edit-form'
import type { FormField, StockRules } from '../../lib/orders/order-form'
import { useStockOfLines } from '../../lib/orders/use-line-stock'
import { useOrder, useOrderWrites } from '../../lib/orders/use-order'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'

import { OrderLinesSection } from './order-lines-section'
import { OrderPriceFields } from './order-price-fields'

// The edit-order drawer: the items, the shipping fee and the discount of an order that exists, in the fields its status
// still accepts (the day, the address, the phones, the notes and the payment are edited on the detail page). The server
// prices the result and may hold it for a price approval; the form sends only what changed and never a total.
export function EditOrderDrawer({
  orderId,
  isOpen,
  onClose
}: {
  orderId: string
  isOpen: boolean
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.edit')
  const [isBusy, setBusy] = useState(false)
  return (
    // Not closed while the change is being saved: the answer, a refusal included, must reach the agent
    <Sheet
      open={isOpen}
      onOpenChange={open => {
        if (!open && !isBusy) onClose()
      }}
    >
      <SheetContent
        className="md:w-[520px] md:max-w-[90vw]"
        // A click on the dimmed page must not throw away what was typed
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        <Body orderId={orderId} onBusy={setBusy} onClose={onClose} />
      </SheetContent>
    </Sheet>
  )
}

function Body({
  orderId,
  onBusy,
  onClose
}: {
  orderId: string
  onBusy: (busy: boolean) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('orders.edit')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const order = useOrder(storeId, orderId, true)
  const writes = useOrderWrites(storeId, orderId)
  const guard = useSubmitGuard()
  // What the form holds is made once from the order: a refresh of the order while it is open must not rewrite what was typed
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [wrong, setWrong] = useState<{ field: FormField; line?: string | undefined } | null>(null)
  const data = order.data
  if (data !== undefined && draft === null) setDraft(draftFromOrder(data))
  const stockOf = useStockOfLines(draft?.lines ?? [])
  const canOverridePrice = can(ClientPermissions.ORDERS_OVERRIDE_PRICE)

  if (data === undefined || draft === null) {
    return (
      <div className="p-4">
        {order.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm">
            <p>{t('failed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void order.refetch()}>
              {tAll('common.tryAgain')}
            </Button>
          </div>
        ) : (
          <p role="status" className="text-muted-foreground text-sm">
            {tAll('common.loading')}
          </p>
        )}
      </div>
    )
  }

  const editable = {
    items: canEditField(data.status, 'items', can),
    shipping: canEditField(data.status, 'shipping', can),
    discount: canEditField(data.status, 'discount', can)
  }
  const patch = (changes: Partial<EditDraft>): void => {
    setDraft({ ...draft, ...changes })
    setWrong(null)
    writes.update.reset()
  }

  const submit = (): void => {
    const stock = new Map<string, StockRules>()
    for (const line of draft.lines) {
      const rules = stockOf(line).rules
      if (rules !== null) stock.set(line.key, rules)
    }
    const result = buildUpdate(draft, data, editable, { canOverridePrice }, stock)
    if (!result.ok) return setWrong({ field: result.field, line: result.line })
    if (!guard.enter()) return
    onBusy(true)
    writes.update.mutate(result.value, {
      onSuccess: updated => {
        const isHeld = updated.priceApprovalStatus === (PriceApprovalStatus.PENDING as string)
        toast.success(t(isHeld ? 'savedAwaitingApproval' : 'saved'))
        onClose()
      },
      onSettled: () => {
        guard.leave()
        onBusy(false)
      }
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-4">
        {!editable.items && !editable.shipping && !editable.discount ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t('locked')}
          </p>
        ) : null}
        <OrderLinesSection
          lines={draft.lines}
          onLines={lines => patch({ lines })}
          canOverridePrice={canOverridePrice}
          stockOf={stockOf}
          wrong={wrong}
          locked={!editable.items}
        />
        <OrderPriceFields
          values={draft}
          onChange={patch}
          wrong={wrong?.field ?? null}
          shippingLocked={!editable.shipping}
          discountLocked={!editable.discount}
        />
        {wrong?.field === 'nothing' ? (
          <p role="alert" className="text-destructive text-sm">
            {t('nothing')}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 border-t p-4">
        <MutationError error={writes.update.error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={writes.update.isPending}
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button
            type="button"
            busy={writes.update.isPending}
            disabled={
              writes.update.isPending ||
              (!editable.items && !editable.shipping && !editable.discount)
            }
            onClick={submit}
          >
            {t('submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
