'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useRef, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { InventoryLimits } from '@platform/core/domain'

import {
  adjustmentFrom,
  emptyStockForm,
  ReasonsOf,
  StockActions,
  type StockFormField,
  type StockFormValues,
  type StockProduct
} from '../../lib/inventory/stock-form'
import { useStockAdjustment, useWarehousesOfStore } from '../../lib/inventory/use-inventory'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// Receiving stock and correcting it by hand (TDD_16 §4.3). The reason is mandatory; the key that makes a retry
// harmless is made when the dialog opens and stays until the adjustment is saved, so a double click, or a send that
// is repeated after a lost answer, adjusts once.
export function StockAdjustDialog({
  product,
  open,
  onOpenChange,
  initial
}: {
  product: StockProduct
  open: boolean
  onOpenChange: (open: boolean) => void
  // Where the form starts: the warehouse and variant of the row the person came from
  initial?: { warehouseId: string; variantId: string | null }
}): ReactElement {
  const { storeId } = useStore()
  // Held here, not in the form, so that the dialog knows a send is in flight: closing it then would lose the answer
  const adjust = useStockAdjustment(storeId)
  return (
    <Dialog
      open={open}
      onOpenChange={next => (next || !adjust.isPending ? onOpenChange(next) : undefined)}
    >
      <DialogContent>
        {/* Mounted only while open: every opening starts a form of its own */}
        {open ? (
          <AdjustForm
            product={product}
            initial={initial}
            adjust={adjust}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function AdjustForm({
  product,
  initial,
  adjust,
  onDone
}: {
  product: StockProduct
  initial: { warehouseId: string; variantId: string | null } | undefined
  adjust: ReturnType<typeof useStockAdjustment>
  onDone: () => void
}): ReactElement {
  const t = useTranslations('products.stock.dialog')
  const tStock = useTranslations('products.stock')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const guard = useSubmitGuard()
  const warehouses = useWarehousesOfStore(storeId, true)
  // A mutation outlives the form: the one of the last opening must not show its refusal in this one
  useEffect(() => adjust.reset(), [adjust.reset])
  const canSetCost = can(ClientPermissions.PRODUCTS_VIEW_COST)
  const [values, setValues] = useState<StockFormValues>(() => ({
    ...emptyStockForm(initial?.warehouseId ?? ''),
    variantId: initial?.variantId ?? ''
  }))
  const [wrong, setWrong] = useState<StockFormField | null>(null)
  // One key per request: the same request sent again (a lost answer, a second click) carries the key it had, so it
  // cannot apply twice; a request that was changed after it failed is another one and gets a key of its own
  const keys = useRef(new Map<string, string>())
  const list = warehouses.data ?? []
  // The first warehouse, when the person did not come from a row and there is only one to choose
  // What the select shows is what is sent: a warehouse that is not among the options (switched off, unlinked, or the list
  // is still on its way) is not kept as a hidden value
  const chosen = list.some(warehouse => warehouse.id === values.warehouseId)
    ? values.warehouseId
    : ''
  const warehouseId = chosen === '' && list.length === 1 ? (list[0]?.id ?? '') : chosen
  const activeVariants = product.variants.filter(variant => variant.active)

  const set = <K extends keyof StockFormValues>(key: K, value: StockFormValues[K]): void => {
    setValues(current => ({ ...current, [key]: value }))
    setWrong(null)
    // The refusal of the api was about what was written before
    adjust.reset()
  }
  const chooseAction = (action: StockFormValues['action']): void => {
    // The reasons change with the action: the first of the new ones, unless the one chosen is also there
    setValues(current => ({
      ...current,
      action,
      reason: ReasonsOf[action].includes(current.reason)
        ? current.reason
        : (ReasonsOf[action][0] ?? current.reason)
    }))
    setWrong(null)
    adjust.reset()
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const result = adjustmentFrom({ ...values, warehouseId }, product, canSetCost)
    if (!result.ok) return setWrong(result.field)
    if (!guard.enter()) return
    const body = JSON.stringify(result.value)
    const idempotencyKey = keys.current.get(body) ?? crypto.randomUUID()
    keys.current.set(body, idempotencyKey)
    adjust.mutate(
      { ...result.value, idempotencyKey },
      {
        onSuccess: answer => {
          toast.success(t(answer.replayed ? 'savedAgain' : 'saved'))
          onDone()
        },
        onSettled: guard.leave
      }
    )
  }

  const fieldError = (field: StockFormField): ReactElement | null =>
    wrong === field ? (
      <p id={`stock-${field}-error`} role="alert" className="text-destructive text-sm">
        {t(`errors.${field}`)}
      </p>
    ) : null
  const invalid = (field: StockFormField) =>
    wrong === field ? { 'aria-invalid': true, 'aria-describedby': `stock-${field}-error` } : {}

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1">
          <Label htmlFor="stock-warehouse">{t('warehouse')}</Label>
          <select
            id="stock-warehouse"
            className={SELECT_CLASS}
            value={warehouseId}
            onChange={event => set('warehouseId', event.target.value)}
            {...invalid('warehouse')}
          >
            <option value="">{t('warehouseNone')}</option>
            {list.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.name}
              </option>
            ))}
          </select>
          {warehouses.isPending ? (
            <p role="status" className="text-muted-foreground text-sm">
              {tAll('common.loading')}
            </p>
          ) : null}
          {warehouses.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p>{t('warehousesFailed')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void warehouses.refetch()}
              >
                {tAll('common.tryAgain')}
              </Button>
            </div>
          ) : null}
          {warehouses.isSuccess && list.length === 0 ? (
            <p role="status" className="text-muted-foreground text-sm">
              {t('noWarehouses')}
            </p>
          ) : null}
          {fieldError('warehouse')}
        </div>
        {activeVariants.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="stock-variant">{t('item')}</Label>
            <select
              id="stock-variant"
              className={SELECT_CLASS}
              value={values.variantId}
              onChange={event => set('variantId', event.target.value)}
              {...invalid('variant')}
            >
              <option value="">{t('itemChoose')}</option>
              {product.variants.map(variant => (
                <option key={variant.id} value={variant.id}>
                  {variant.name}
                </option>
              ))}
            </select>
            {fieldError('variant')}
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor="stock-action">{t('action')}</Label>
          <select
            id="stock-action"
            className={SELECT_CLASS}
            value={values.action}
            onChange={event => chooseAction(event.target.value as StockFormValues['action'])}
          >
            {Object.values(StockActions).map(action => (
              <option key={action} value={action}>
                {t(`actions.${action}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="stock-quantity">{t('quantity')}</Label>
            <Input
              id="stock-quantity"
              inputMode="numeric"
              autoComplete="off"
              value={values.quantity}
              onChange={event => set('quantity', event.target.value)}
              {...invalid('quantity')}
            />
            {fieldError('quantity')}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="stock-reason">{t('reason')}</Label>
            <select
              id="stock-reason"
              className={SELECT_CLASS}
              value={values.reason}
              onChange={event => set('reason', event.target.value as StockFormValues['reason'])}
            >
              {ReasonsOf[values.action].map(reason => (
                <option key={reason} value={reason}>
                  {tStock(`reasons.${reason}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {canSetCost && values.action !== StockActions.REMOVE ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="stock-unit-cost">{t('unitCost')}</Label>
            <Input
              id="stock-unit-cost"
              inputMode="decimal"
              autoComplete="off"
              value={values.unitCost}
              onChange={event => set('unitCost', event.target.value)}
              {...invalid('unitCost')}
            />
            <p className="text-muted-foreground text-sm">{t('unitCostHelp')}</p>
            {fieldError('unitCost')}
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor="stock-note">{t('note')}</Label>
          <Input
            id="stock-note"
            maxLength={InventoryLimits.NOTE_MAX_LENGTH}
            autoComplete="off"
            value={values.note}
            onChange={event => set('note', event.target.value)}
            {...invalid('note')}
          />
          {fieldError('note')}
        </div>
        <MutationError error={adjust.error} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={adjust.isPending} onClick={onDone}>
            {t('cancel')}
          </Button>
          <Button type="submit" busy={adjust.isPending} disabled={adjust.isPending}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </>
  )
}
