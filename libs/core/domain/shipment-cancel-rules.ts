import { GuideAffectingFields, type GuideAffectingField } from './shipping-constants'
import { PaymentMethod } from './status-enums'

// What a guide was made from (TDD_17 §4.8): the parts of an order that the carrier was told, or that decide what it collects.
// An edit that changes any of them leaves the guide wrong, so the guide is voided and another one is made; any other edit (a
// note, the schedule, a price that no carrier collects) leaves it alone.

export interface GuideSource {
  // The address as stored (a JSON object, or null)
  address: unknown
  recipientPhones: readonly string[] | null
  paymentMethod: string
  items: readonly { productId: string; variantId: string | null; quantity: number }[]
  totalCents: number
  // The carrier the order plans to use (a guide made for another one is the wrong guide)
  carrierConnectionId: string | null
}

// Same value whatever the order of the keys, and a key that says nothing (missing, null or blank) is no key: a form that sends
// the address again with a `line2: null` where the stored one has none changes nothing
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value.trim())
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null && !isBlank(item))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const isBlank = (value: unknown): boolean => typeof value === 'string' && value.trim() === ''

const itemKey = (item: GuideSource['items'][number]): string =>
  `${item.productId}:${item.variantId ?? ''}:${item.quantity}`

// The same lines in any order are the same lines
function sameItems(a: GuideSource['items'], b: GuideSource['items']): boolean {
  const left = a.map(itemKey).sort()
  const right = b.map(itemKey).sort()
  return left.length === right.length && left.every((key, index) => key === right[index])
}

export function guideAffectingChanges(
  before: GuideSource,
  after: GuideSource
): readonly GuideAffectingField[] {
  const changed: GuideAffectingField[] = []
  if (canonical(before.address) !== canonical(after.address)) {
    changed.push(GuideAffectingFields.ADDRESS)
  }
  if (canonical(before.recipientPhones ?? []) !== canonical(after.recipientPhones ?? [])) {
    changed.push(GuideAffectingFields.RECIPIENT_PHONES)
  }
  if (before.paymentMethod !== after.paymentMethod) {
    changed.push(GuideAffectingFields.PAYMENT_METHOD)
  }
  if (!sameItems(before.items, after.items)) changed.push(GuideAffectingFields.ITEMS)
  if (before.carrierConnectionId !== after.carrierConnectionId) {
    changed.push(GuideAffectingFields.CARRIER)
  }
  // What the carrier collects is the total of a cash-on-delivery order; a prepaid one collects nothing
  const cashOnDelivery: string = PaymentMethod.CASH_ON_DELIVERY
  const collects = before.paymentMethod === cashOnDelivery || after.paymentMethod === cashOnDelivery
  if (collects && before.totalCents !== after.totalCents) {
    changed.push(GuideAffectingFields.COD_TOTAL)
  }
  return changed
}
