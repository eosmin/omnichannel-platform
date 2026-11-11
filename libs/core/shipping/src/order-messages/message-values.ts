import { OrderMessageVariables } from '@platform/core/domain'
import { type Locale, Locales } from '@platform/core/i18n'

import type { OrderMessageValues } from './message-template'

export interface OrderMessageItem {
  name: string
  variantLabel: string | null
  quantity: number
  unitPriceCents: number
}

export interface OrderMessageAddress {
  line1: string
  line2?: string | undefined
  city: string
  state?: string | undefined
  postalCode?: string | undefined
  country: string
}

// What an order message can say, as plain data: the service that sends reads it from the rows, the preview invents it. A
// value that is null is a value the order does not have, and the variable that needs it is reported as missing.
export interface OrderMessageSource {
  customerName: string | null
  orderNumber: string
  items: readonly OrderMessageItem[]
  totalCents: number
  currency: string
  shippingAddress: OrderMessageAddress | null
  carrierName: string | null
  trackingNumber: string | null
  trackingUrl: string | null
  storeName: string
  // Cash on delivery only: what the courier collects
  codAmountCents: number | null
  failedAttempts: number | null
  maxAttempts: number | null
  // A calendar day with no time of day (D18): read as UTC midnight, never shifted by a timezone
  scheduledDeliveryDate: Date | null
}

const CENTS_PER_UNIT = 100

// Money in the currency of the order, written the way the customer's language writes it
export function formatMoney(cents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
    cents / CENTS_PER_UNIT
  )
}

// "martes 28 de octubre": the weekday, the day and the month in long form. Some versions of the locale data put a comma after
// the weekday in Spanish; the message reads as it was written in the TDD without it. English keeps its own ("Tuesday, October 28").
export function formatLongDate(day: Date, locale: Locale): string {
  const text = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC'
  }).format(day)
  return locale === Locales.ES ? text.replace(/^(\p{L}+),\s*/u, '$1 ') : text
}

// One line of the list of items: `2 × Name (variant) — $10.00`, the price being the line's (quantity times unit price)
export function formatItemLine(item: OrderMessageItem, currency: string, locale: Locale): string {
  const variant = item.variantLabel === null ? '' : ` (${item.variantLabel})`
  const price = formatMoney(item.quantity * item.unitPriceCents, currency, locale)
  return `${item.quantity} × ${item.name}${variant} — ${price}`
}

// One line per item
export function formatItemsList(
  items: readonly OrderMessageItem[],
  currency: string,
  locale: Locale
): string {
  return items.map(item => formatItemLine(item, currency, locale)).join('\n')
}

export function formatAddress(address: OrderMessageAddress): string {
  const region = [address.city, address.state, address.postalCode]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ')
  return [address.line1, address.line2, region, address.country]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ')
}

const present = (value: string | null): string | undefined =>
  value === null || value.trim() === '' ? undefined : value

// The value of every variable the order has. A variable it has no value for is left out, not filled with an empty text:
// the renderer then refuses the message instead of sending a hole ("your order arrives on .").
export function buildOrderMessageValues(
  source: OrderMessageSource,
  locale: Locale
): OrderMessageValues {
  const values: OrderMessageValues = {
    [OrderMessageVariables.ORDER_NUMBER]: source.orderNumber,
    [OrderMessageVariables.STORE_NAME]: source.storeName,
    [OrderMessageVariables.TOTAL]: formatMoney(source.totalCents, source.currency, locale)
  }
  const assign = (name: keyof OrderMessageValues, value: string | undefined): void => {
    if (value !== undefined) values[name] = value
  }
  assign(OrderMessageVariables.CUSTOMER_NAME, present(source.customerName))
  assign(
    OrderMessageVariables.ITEMS_LIST,
    source.items.length === 0 ? undefined : formatItemsList(source.items, source.currency, locale)
  )
  assign(
    OrderMessageVariables.SHIPPING_ADDRESS,
    source.shippingAddress === null ? undefined : formatAddress(source.shippingAddress)
  )
  assign(OrderMessageVariables.CARRIER_NAME, present(source.carrierName))
  assign(OrderMessageVariables.TRACKING_NUMBER, present(source.trackingNumber))
  assign(OrderMessageVariables.TRACKING_URL, present(source.trackingUrl))
  assign(
    OrderMessageVariables.COD_AMOUNT,
    source.codAmountCents === null
      ? undefined
      : formatMoney(source.codAmountCents, source.currency, locale)
  )
  assign(
    OrderMessageVariables.ATTEMPT_NUMBER,
    source.failedAttempts === null ? undefined : String(source.failedAttempts)
  )
  assign(
    OrderMessageVariables.MAX_ATTEMPTS,
    source.maxAttempts === null ? undefined : String(source.maxAttempts)
  )
  assign(
    OrderMessageVariables.SCHEDULED_DELIVERY_DATE,
    source.scheduledDeliveryDate === null
      ? undefined
      : formatLongDate(source.scheduledDeliveryDate, locale)
  )
  return values
}
