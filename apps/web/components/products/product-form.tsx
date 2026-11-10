'use client'

import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { ProductDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { ProductConflicts, ProductLimits } from '@platform/core/domain'

import { conflictOf, historyCountsOf } from '../../lib/products/product-conflict'
import {
  EMPTY_PRODUCT_FORM,
  formFromProduct,
  type ProductFormField,
  type ProductFormValues,
  productChangesFrom,
  productInputFrom
} from '../../lib/products/product-form'
import { useProductWrites } from '../../lib/products/use-products'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

import { ConfirmRemove } from './confirm-remove'
import { ProductError } from './product-error'

// The "Details" tab (and the whole sheet of a new product). Who may not edit sees the values and no way to
// change them. An edit sends only what differs; the api answers the SKU that is taken, and the form says so.
export function ProductForm({
  product,
  onCreated,
  onRemoved
}: {
  // Null: a new product
  product: ProductDetailView | null
  onCreated: (productId: string) => void
  onRemoved: () => void
}): ReactElement {
  const t = useTranslations('products')
  const { storeId, can } = useStore()
  const guard = useSubmitGuard()
  const writes = useProductWrites(storeId, product?.id ?? null)
  const [values, setValues] = useState<ProductFormValues>(
    product === null ? EMPTY_PRODUCT_FORM : formFromProduct(product)
  )
  const [wrong, setWrong] = useState<ProductFormField | null>(null)
  const [isRemoving, setRemoving] = useState(false)
  const mayEdit =
    product === null ? can(ClientPermissions.PRODUCTS_CREATE) : can(ClientPermissions.PRODUCTS_EDIT)
  const mayDelete = product !== null && can(ClientPermissions.PRODUCTS_DELETE)
  // Archiving is a change of the product: asking it of who may only delete would end in a 403
  const mayArchive = product !== null && can(ClientPermissions.PRODUCTS_EDIT)
  const error = writes.create.error ?? writes.update.error

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]): void => {
    setValues(current => ({ ...current, [key]: value }))
    setWrong(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!mayEdit) return
    if (product === null) {
      const result = productInputFrom(values)
      if (!result.ok) return setWrong(result.field)
      if (!guard.enter()) return
      writes.create.mutate(result.value, {
        onSuccess: created => {
          toast.success(t('form.created'))
          onCreated(created.id)
        },
        onSettled: guard.leave
      })
      return
    }
    const result = productChangesFrom(product, values)
    if (!result.ok) return setWrong(result.field)
    if (Object.keys(result.value).length === 0) {
      toast(t('form.unchanged'))
      return
    }
    if (!guard.enter()) return
    writes.update.mutate(result.value, {
      onSuccess: () => toast.success(t('form.saved')),
      onSettled: guard.leave
    })
  }

  // Archiving is a PATCH of `active`, not a separate route; it is what the api asks for when a delete is refused
  const setActive = (active: boolean): void => {
    if (product === null || !guard.enter()) return
    writes.update.mutate(
      { active },
      {
        onSuccess: () => {
          setValues(current => ({ ...current, active }))
          toast.success(t(active ? 'form.restored' : 'form.archived'))
          setRemoving(false)
          writes.remove.reset()
        },
        onSettled: guard.leave
      }
    )
  }

  const remove = (): void => {
    if (!guard.enter()) return
    writes.remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(t('delete.deleted'))
        setRemoving(false)
        onRemoved()
      },
      onSettled: guard.leave
    })
  }

  const fieldError = (field: ProductFormField): ReactElement | null =>
    wrong === field ? (
      <p id={`product-${field}-error`} role="alert" className="text-destructive text-sm">
        {t(`form.errors.${field}`)}
      </p>
    ) : null
  const invalid = (field: ProductFormField) =>
    wrong === field ? { 'aria-invalid': true, 'aria-describedby': `product-${field}-error` } : {}

  const history = writes.remove.error
  const hasHistory = conflictOf(history) === ProductConflicts.HAS_HISTORY
  const counts = historyCountsOf(history)
  const parts = (['orderItems', 'inventoryMovements', 'media'] as const)
    .filter(key => counts[key] > 0)
    .map(key => t(`delete.history.${key}`, { count: counts[key] }))
    .join(', ')

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1">
        <Label htmlFor="product-name">{t('form.name')}</Label>
        <Input
          id="product-name"
          value={values.name}
          maxLength={ProductLimits.NAME_MAX_LENGTH}
          disabled={!mayEdit}
          onChange={event => set('name', event.target.value)}
          {...invalid('name')}
        />
        {fieldError('name')}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="product-price">{t('form.price')}</Label>
          <Input
            id="product-price"
            inputMode="decimal"
            value={values.price}
            disabled={!mayEdit}
            onChange={event => set('price', event.target.value)}
            {...invalid('price')}
          />
          {fieldError('price')}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="product-cost">{t('form.cost')}</Label>
          <Input
            id="product-cost"
            inputMode="decimal"
            value={values.cost}
            disabled={!mayEdit}
            onChange={event => set('cost', event.target.value)}
            {...invalid('cost')}
          />
          <p className="text-muted-foreground text-xs">{t('form.costHelp')}</p>
          {fieldError('cost')}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="product-sku">{t('form.sku')}</Label>
        <Input
          id="product-sku"
          value={values.sku}
          maxLength={ProductLimits.SKU_MAX_LENGTH}
          disabled={!mayEdit}
          onChange={event => set('sku', event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="product-description">{t('form.description')}</Label>
        <Textarea
          id="product-description"
          rows={4}
          value={values.description}
          maxLength={ProductLimits.DESCRIPTION_MAX_LENGTH}
          disabled={!mayEdit}
          onChange={event => set('description', event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={values.trackInventory}
            disabled={!mayEdit}
            onChange={event => set('trackInventory', event.target.checked)}
          />
          {t('form.trackInventory')}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={values.freeShipping}
            disabled={!mayEdit}
            onChange={event => set('freeShipping', event.target.checked)}
          />
          {t('form.freeShipping')}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={values.active}
            disabled={!mayEdit}
            onChange={event => set('active', event.target.checked)}
          />
          {t('form.active')}
        </label>
      </div>
      {values.trackInventory ? (
        <div className="flex max-w-48 flex-col gap-1">
          <Label htmlFor="product-threshold">{t('form.lowStockThreshold')}</Label>
          <Input
            id="product-threshold"
            inputMode="numeric"
            value={values.lowStockThreshold}
            disabled={!mayEdit}
            onChange={event => set('lowStockThreshold', event.target.value)}
            {...invalid('lowStockThreshold')}
          />
          <p className="text-muted-foreground text-xs">{t('form.lowStockHelp')}</p>
          {fieldError('lowStockThreshold')}
        </div>
      ) : null}
      <ProductError error={error} />
      {mayEdit || mayDelete ? (
        <div className="flex flex-wrap items-center gap-2">
          {mayEdit ? (
            <Button
              type="submit"
              disabled={writes.create.isPending || writes.update.isPending}
              busy={writes.create.isPending || writes.update.isPending}
            >
              {product === null ? t('form.create') : t('form.save')}
            </Button>
          ) : null}
          {mayArchive ? (
            <Button
              type="button"
              variant="outline"
              disabled={writes.update.isPending}
              onClick={() => setActive(!product.active)}
            >
              {product.active ? <Archive aria-hidden /> : <ArchiveRestore aria-hidden />}
              {product.active ? t('form.archive') : t('form.restore')}
            </Button>
          ) : null}
          {mayDelete ? (
            <Button type="button" variant="ghost" onClick={() => setRemoving(true)}>
              <Trash2 aria-hidden />
              {t('form.delete')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {product !== null ? (
        <ConfirmRemove
          isOpen={isRemoving}
          title={hasHistory ? t('delete.history.title') : t('delete.title')}
          body={
            hasHistory
              ? t('delete.history.body', { parts })
              : t('delete.body', { name: product.name })
          }
          confirmLabel={hasHistory ? t('delete.history.archive') : t('delete.confirm')}
          isPending={writes.remove.isPending}
          error={hasHistory ? null : history}
          canConfirm={!hasHistory || mayArchive}
          onConfirm={hasHistory ? () => setActive(false) : remove}
          onCancel={() => {
            setRemoving(false)
            writes.remove.reset()
          }}
        />
      ) : null}
    </form>
  )
}
