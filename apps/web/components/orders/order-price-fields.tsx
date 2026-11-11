'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { OrderLimits } from '@platform/core/domain'

import type { FormField } from '../../lib/orders/order-form'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export interface PriceValues {
  shippingText: string
  discountText: string
  discountReason: string
}

// The shipping fee and the discount of an order form, shared by the create drawer and the edit drawer. The server prices
// the order: these are the only two amounts a member writes (a line's price is the catalog's unless it is overridden).
export function OrderPriceFields({
  values,
  onChange,
  wrong,
  shippingLocked = false,
  discountLocked = false,
  reasonLocked = discountLocked
}: {
  values: PriceValues
  onChange: (changes: Partial<PriceValues>) => void
  wrong: FormField | null
  shippingLocked?: boolean
  discountLocked?: boolean
  // The reason also belongs to the fee when the discount is locked and the order has none
  reasonLocked?: boolean
}): ReactElement {
  const t = useTranslations('orders.create')
  const error = (field: FormField): ReactElement | null =>
    wrong === field ? (
      <p id={`order-${field}-error`} role="alert" className="text-destructive text-sm">
        {t(`errors.${field}`)}
      </p>
    ) : null
  const invalid = (field: FormField) =>
    wrong === field ? { 'aria-invalid': true, 'aria-describedby': `order-${field}-error` } : {}
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="order-shipping">{t('prices.shipping')}</Label>
        <Input
          id="order-shipping"
          inputMode="decimal"
          autoComplete="off"
          disabled={shippingLocked}
          value={values.shippingText}
          onChange={event => onChange({ shippingText: event.target.value })}
          {...invalid('shipping')}
        />
        {error('shipping')}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="order-discount">{t('prices.discount')}</Label>
        <Input
          id="order-discount"
          inputMode="decimal"
          autoComplete="off"
          disabled={discountLocked}
          value={values.discountText}
          onChange={event => onChange({ discountText: event.target.value })}
          {...invalid('discount')}
        />
        {error('discount')}
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor="order-discount-reason">{t('prices.discountReason')}</Label>
        <Input
          id="order-discount-reason"
          autoComplete="off"
          disabled={reasonLocked}
          maxLength={OrderLimits.PRICE_REASON_MAX_LENGTH}
          value={values.discountReason}
          onChange={event => onChange({ discountReason: event.target.value })}
          {...invalid('discountReason')}
        />
        <p className="text-muted-foreground text-xs">{t('prices.discountHelp')}</p>
        {error('discountReason')}
      </div>
    </section>
  )
}
