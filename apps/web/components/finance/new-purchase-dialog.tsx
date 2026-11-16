'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { PurchaseLimits } from '@platform/core/domain'

import {
  createOrderInputOf,
  emptyOrderHeaderDraft,
  newIdempotencyKey,
  type OrderHeaderDraft,
  type OrderHeaderField,
  OrderHeaderFields,
  orderHeaderProblem
} from '../../lib/finance/purchase-form'
import { usePurchaseErrorText } from '../../lib/finance/use-purchase-error-text'
import { useAllSuppliers, useCreatePurchaseOrder } from '../../lib/finance/use-purchases'
import { useWarehousesOfStore } from '../../lib/inventory/use-inventory'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { SelectField, TextField } from './fields'

// Starting a purchase order (TDD_18 §2.7): the supplier and the warehouse the goods will go to, when they are expected and a note. It is
// made a draft with no lines; its page is where the lines are chosen, so nothing is promised to the supplier until it is marked ordered.
export function NewPurchaseDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.newOrder')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? <NewPurchaseForm onBusy={setBusy} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function NewPurchaseForm({
  onBusy,
  onDone
}: {
  onBusy: (busy: boolean) => void
  onDone: () => void
}): ReactElement {
  const t = useTranslations('finance.purchases.newOrder')
  const errorText = usePurchaseErrorText()
  const router = useRouter()
  const { storeId } = useStore()
  const guard = useSubmitGuard()
  const suppliers = useAllSuppliers(storeId, true)
  const warehouses = useWarehousesOfStore(storeId, true)
  const create = useCreatePurchaseOrder(storeId)
  // One key for the life of the form: a double click or a retry after a lost answer is the same order
  const [key] = useState(newIdempotencyKey)
  useEffect(() => {
    onBusy(create.isPending)
    return () => onBusy(false)
  }, [create.isPending, onBusy])
  const [draft, setDraft] = useState<OrderHeaderDraft>(emptyOrderHeaderDraft)
  const [wrong, setWrong] = useState<OrderHeaderField | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  const set = (patch: Partial<OrderHeaderDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setWrong(null)
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const problem = orderHeaderProblem(draft)
    if (problem !== null) {
      setWrong(problem)
      return
    }
    if (!guard.enter()) return
    create.mutate(createOrderInputOf(draft, key), {
      onSuccess: order => {
        toast.success(t('created', { number: order.number }))
        onDone()
        router.push(AppPaths.finance.purchase(order.id))
      },
      onError: error => setRefusal(errorText(error)),
      onSettled: guard.leave
    })
  }

  const problemText = (field: OrderHeaderField): string | null =>
    wrong === field ? t(`problems.${field}`) : null
  const failed = suppliers.isError || warehouses.isError

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label={t('formLabel')}>
      <SelectField
        label={t('fields.supplier')}
        value={draft.supplierId}
        disabled={create.isPending}
        problem={problemText(OrderHeaderFields.SUPPLIER)}
        onChange={supplierId => set({ supplierId })}
      >
        <option value="">{t('fields.pickSupplier')}</option>
        {(suppliers.data ?? [])
          .filter(supplier => supplier.active)
          .map(supplier => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
      </SelectField>
      <SelectField
        label={t('fields.warehouse')}
        value={draft.warehouseId}
        hint={t('fields.warehouseHint')}
        disabled={create.isPending}
        problem={problemText(OrderHeaderFields.WAREHOUSE)}
        onChange={warehouseId => set({ warehouseId })}
      >
        <option value="">{t('fields.pickWarehouse')}</option>
        {(warehouses.data ?? []).map(warehouse => (
          <option key={warehouse.id} value={warehouse.id}>
            {warehouse.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label={t('fields.expectedOn')}
        value={draft.expectedOn}
        maxLength={10}
        disabled={create.isPending}
        hint={t('fields.dateHint')}
        problem={problemText(OrderHeaderFields.EXPECTED_ON)}
        onChange={expectedOn => set({ expectedOn })}
      />
      <TextField
        label={t('fields.notes')}
        value={draft.notes}
        maxLength={PurchaseLimits.NOTES_MAX_LENGTH}
        disabled={create.isPending}
        problem={problemText(OrderHeaderFields.NOTES)}
        onChange={notes => set({ notes })}
      />
      {failed ? (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refusal}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={create.isPending}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {t('create')}
        </Button>
      </div>
    </form>
  )
}
