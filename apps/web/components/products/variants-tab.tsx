'use client'

import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { ProductDetailView, ProductVariantView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { ProductLimits } from '@platform/core/domain'

import { formatCents } from '../../lib/products/money'
import {
  EMPTY_VARIANT_FORM,
  formFromVariant,
  variantChangesFrom,
  type VariantFormField,
  type VariantFormValues,
  variantInputFrom
} from '../../lib/products/product-form'
import { useVariantWrites } from '../../lib/products/use-products'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

import { ConfirmRemove } from './confirm-remove'
import { ProductError } from './product-error'

// The "Variants" tab: a table with the variants of the product, one row open for editing at a time, and a
// row to add one. A variant with no price or cost of its own shows the product's, said as such.
export function VariantsTab({ product }: { product: ProductDetailView }): ReactElement {
  const t = useTranslations('products.variants')
  const format = useFormatter()
  const { storeId, can } = useStore()
  const writes = useVariantWrites(storeId, product.id)
  // 'new', the id of the variant being edited, or null
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ProductVariantView | null>(null)
  const mayCreate = can(ClientPermissions.PRODUCTS_CREATE)
  const mayEdit = can(ClientPermissions.PRODUCTS_EDIT)
  const mayDelete = can(ClientPermissions.PRODUCTS_DELETE)
  // Without the permission the column is not drawn and no cost is sent (the api's own half is PR A2)
  const mayViewCost = can(ClientPermissions.PRODUCTS_VIEW_COST)
  const money = (cents: number): string => formatCents(format, cents)

  return (
    <section aria-labelledby="product-variants-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h3 id="product-variants-heading" className="font-medium">
            {t('heading')}
          </h3>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {mayCreate && editing === null ? (
          <Button type="button" variant="outline" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('add')}
          </Button>
        ) : null}
      </div>
      {product.variants.length === 0 && editing !== 'new' ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-3 font-medium">{t('columns.name')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.sku')}</th>
                <th className="py-2 pr-3 font-medium">{t('columns.price')}</th>
                {mayViewCost ? (
                  <th className="py-2 pr-3 font-medium">{t('columns.cost')}</th>
                ) : null}
                <th className="py-2 font-medium">
                  <span className="sr-only">{t('columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map(variant =>
                editing === variant.id ? (
                  <VariantRow
                    key={variant.id}
                    variant={variant}
                    productId={product.id}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  <tr key={variant.id} className="border-b align-top">
                    <td className="py-2 pr-3">{variant.name}</td>
                    <td className="text-muted-foreground py-2 pr-3">{variant.sku ?? ''}</td>
                    <td className="py-2 pr-3">
                      {variant.priceCents === null ? (
                        <span className="text-muted-foreground">{t('usesProduct')}</span>
                      ) : (
                        money(variant.priceCents)
                      )}
                    </td>
                    {mayViewCost ? (
                      <td className="py-2 pr-3">
                        {variant.costCents === null ? (
                          <span className="text-muted-foreground">{t('usesProductCost')}</span>
                        ) : (
                          money(variant.costCents)
                        )}
                      </td>
                    ) : null}
                    <td className="py-2 whitespace-nowrap">
                      {mayEdit ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={editing !== null}
                          onClick={() => setEditing(variant.id)}
                        >
                          <Pencil aria-hidden />
                          {t('edit')}
                        </Button>
                      ) : null}
                      {mayDelete ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setRemoving(variant)}
                        >
                          <Trash2 aria-hidden />
                          {t('delete')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                )
              )}
              {editing === 'new' ? (
                <VariantRow variant={null} productId={product.id} onDone={() => setEditing(null)} />
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmRemove
        isOpen={removing !== null}
        title={t('deleteTitle')}
        body={t('deleteBody', { name: removing?.name ?? '' })}
        confirmLabel={t('delete')}
        isPending={writes.remove.isPending}
        error={writes.remove.error}
        onConfirm={() => {
          if (removing === null) return
          writes.remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success(t('deleted'))
              setRemoving(null)
            }
          })
        }}
        onCancel={() => {
          setRemoving(null)
          writes.remove.reset()
        }}
      />
    </section>
  )
}

// A row of inputs: a new variant (`variant` null) or the one being edited. Money is typed as text and read
// as whole cents; an empty price or cost means "the one of the product".
function VariantRow({
  variant,
  productId,
  onDone
}: {
  variant: ProductVariantView | null
  productId: string
  onDone: () => void
}): ReactElement {
  const t = useTranslations('products.variants')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const mayViewCost = can(ClientPermissions.PRODUCTS_VIEW_COST)
  const guard = useSubmitGuard()
  const writes = useVariantWrites(storeId, productId)
  const [values, setValues] = useState<VariantFormValues>(
    variant === null ? EMPTY_VARIANT_FORM : formFromVariant(variant)
  )
  const [wrong, setWrong] = useState<VariantFormField | null>(null)
  const formId = `variant-form-${variant?.id ?? 'new'}`
  const pending = writes.add.isPending || writes.edit.isPending

  const set = (key: keyof VariantFormValues, value: string): void => {
    setValues(current => ({ ...current, [key]: value }))
    setWrong(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (variant === null) {
      const result = variantInputFrom(values, mayViewCost)
      if (!result.ok) return setWrong(result.field)
      if (!guard.enter()) return
      writes.add.mutate(result.value, {
        onSuccess: () => {
          toast.success(t('added'))
          onDone()
        },
        onSettled: guard.leave
      })
      return
    }
    const result = variantChangesFrom(variant, values, mayViewCost)
    if (!result.ok) return setWrong(result.field)
    if (Object.keys(result.value).length === 0) {
      toast(t('unchanged'))
      onDone()
      return
    }
    if (!guard.enter()) return
    writes.edit.mutate(
      { variantId: variant.id, changes: result.value },
      {
        onSuccess: () => {
          toast.success(t('saved'))
          onDone()
        },
        onSettled: guard.leave
      }
    )
  }

  const cell = (key: keyof VariantFormValues, label: string, max?: number): ReactElement => (
    <td className="py-2 pr-3">
      <Input
        form={formId}
        aria-label={label}
        value={values[key]}
        maxLength={max}
        inputMode={key === 'price' || key === 'cost' ? 'decimal' : undefined}
        onChange={event => set(key, event.target.value)}
        aria-invalid={wrong === key ? true : undefined}
        aria-describedby={wrong === key ? `${formId}-error` : undefined}
      />
    </td>
  )

  return (
    <>
      <tr className="border-b align-top">
        {cell('name', t('name'), ProductLimits.VARIANT_NAME_MAX_LENGTH)}
        {cell('sku', t('columns.sku'), ProductLimits.SKU_MAX_LENGTH)}
        {cell('price', t('columns.price'))}
        {mayViewCost ? cell('cost', t('columns.cost')) : null}
        <td className="py-2 whitespace-nowrap">
          <form id={formId} onSubmit={submit} noValidate className="flex gap-1">
            <Button type="submit" size="sm" disabled={pending} busy={pending}>
              {t('save')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              {tAll('common.cancel')}
            </Button>
          </form>
        </td>
      </tr>
      {wrong !== null || writes.add.error !== null || writes.edit.error !== null ? (
        <tr>
          <td colSpan={mayViewCost ? 5 : 4} className="pb-2">
            {wrong !== null ? (
              <p id={`${formId}-error`} role="alert" className="text-destructive text-sm">
                {t(`errors.${wrong}`)}
              </p>
            ) : (
              <ProductError error={writes.add.error ?? writes.edit.error} />
            )}
          </td>
        </tr>
      ) : null}
    </>
  )
}
