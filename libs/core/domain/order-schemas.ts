import { z } from 'zod'

import { CustomerLimits, DEFAULT_PHONE_REGION } from './customer-constants'
import {
  ORDER_MAX_AMOUNT_CENTS,
  OrderLimits,
  OrderListFilters,
  OrderScheduleFilters,
  OrderScheduledDeliveryShortcuts,
  OrderSorts,
  RecipientPhones
} from './order-constants'
import {
  OrderConfirmationChannel,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PriceApprovalStatus,
  type OrderEditableField
} from './status-enums'
import { singleLineText } from './validation'

// The shared schemas of the orders (TDD_02 §13): the server validates the body with them and the web forms use the
// same ones. Every shape is strict: a field the schema does not name is refused, which is how the server refuses a
// price, a total or a status that comes from the client. The only prices an order takes are the shipping fee and the
// discount; the unit prices and the totals are read and computed on the server (TDD_17 §4.13).

const cents = z.number().int().min(0).max(ORDER_MAX_AMOUNT_CENTS)

// A uuid is valid in either case and the rows hold it in lower case: the server compares ids as strings, so it reads
// them in the one form (a product written in capitals is the same product, not a 404)
export const lowercasedUuidSchema = z.uuid().transform(value => value.toLowerCase())
const id = lowercasedUuidSchema

// Postgres text cannot hold a NUL character: a 400 here and not a 500 there
const freeText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })

// A note, a reason: blank is no note, and no note is null, so "cleared" and "never written" are one state
const optionalText = (maxLength: number) =>
  freeText(maxLength).transform(value => (value === '' ? null : value))

// The recipient's phones, as the carriers receive them (they take national digits, no country code): digits only.
// Spaces, '+' and dashes are stripped before validating, so what is stored is what is sent. The first one is the main
// number; a repeated number (same digits) is refused, not silently dropped. A number copied from Customer.phone
// (always international) is reduced to its national number by the form and by the backfill, not here.
// What a person types in a phone field: digits and the separators that are stripped. A letter ("ext 5") is refused,
// not dropped: dropping it would merge an extension into the number and send the carrier a different one.
// A '+' only opens the number (an international form is stripped here and reduced to its national number by the form,
// which knows the country: the schema cannot), and one inside the digits is a typo that would merge two numbers.
const PHONE_TYPED_CHARACTERS = /^\+?[\d\s\-().]+$/

export const recipientPhonesSchema = z
  .array(
    z
      .string()
      .regex(PHONE_TYPED_CHARACTERS)
      .transform(value => value.replace(/\D/g, ''))
      .pipe(z.string().min(RecipientPhones.MIN_DIGITS).max(RecipientPhones.MAX_DIGITS))
  )
  .min(1)
  .max(RecipientPhones.MAX_COUNT)
  .refine(phones => new Set(phones).size === phones.length, {
    message: 'a phone number is repeated'
  })

// 'YYYY-MM-DD', a calendar day in the timezone of the store; a past day is accepted (decision D18)
export const scheduledDeliveryDateSchema = z.iso.date()

const itemSchema = z.strictObject({
  productId: id,
  variantId: id.optional(),
  // The price of a line is the catalog's, read by the server when the line is made. The only way to name another is
  // `unitPriceCents` with its `priceReason`, which the server takes from a member with ORDERS_OVERRIDE_PRICE alone
  // (TDD_17 §4.13, level 1) and refuses from anybody else: a price equal to the catalog's is no override.
  quantity: z.number().int().min(1).max(OrderLimits.MAX_QUANTITY_PER_LINE),
  unitPriceCents: cents.optional(),
  priceReason: optionalText(OrderLimits.PRICE_REASON_MAX_LENGTH).optional()
})

// The same product and variant twice is one line with the quantities added: the form does that, the server refuses it
function hasNoRepeatedLine(items: readonly { productId: string; variantId?: string }[]): boolean {
  // A uuid is valid in either case: the same product written twice is still one product
  const key = (item: { productId: string; variantId?: string }) =>
    `${item.productId}:${item.variantId ?? ''}`.toLowerCase()
  return new Set(items.map(key)).size === items.length
}

const itemsSchema = z
  .array(itemSchema)
  .min(1)
  .max(OrderLimits.MAX_LINES)
  .refine(hasNoRepeatedLine, { message: 'a product and variant appear twice' })

const addressField = singleLineText(CustomerLimits.ADDRESS_FIELD_MAX_LENGTH, 1)

export const orderShippingAddressSchema = z.strictObject({
  line1: addressField,
  line2: addressField.optional(),
  city: addressField,
  state: addressField.optional(),
  postalCode: singleLineText(CustomerLimits.ADDRESS_POSTAL_CODE_MAX_LENGTH, 1).optional(),
  // ISO 3166-1 alpha-2
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform(code => code.toUpperCase())
    .default(DEFAULT_PHONE_REGION)
})

// The reason of a discount, or of a fee outside the range of its carrier (one field for both, TDD_17 §4.13)
const priceReasonSchema = optionalText(OrderLimits.PRICE_REASON_MAX_LENGTH)

// The three notes of an order, each with its own audience (see OrderEditableField)
const customerNotes = optionalText(OrderLimits.CUSTOMER_NOTES_MAX_LENGTH)
const internalNotes = optionalText(OrderLimits.INTERNAL_NOTES_MAX_LENGTH)
const packingNotes = optionalText(OrderLimits.PACKING_NOTES_MAX_LENGTH)

export const createOrderSchema = z.strictObject({
  customerId: id,
  conversationId: id.optional(),
  items: itemsSchema,
  shippingCents: cents.default(0),
  discountCents: cents.default(0),
  discountReason: priceReasonSchema.optional(),
  paymentMethod: z.enum(PaymentMethod),
  shippingAddress: orderShippingAddressSchema.optional(),
  // The form pre-fills it from Customer.phone, as its national number
  recipientPhones: recipientPhonesSchema,
  customerNotes: customerNotes.optional(),
  internalNotes: internalNotes.optional(),
  packingNotes: packingNotes.optional(),
  scheduledDeliveryDate: scheduledDeliveryDateSchema.nullable().default(null),
  // Shown only to members with ORDERS_CONFIRM; the server refuses the flag from a caller without it (TDD_17 §4.3)
  confirmOnCreate: z.boolean().default(false),
  sendConfirmationMessage: z.boolean().default(true)
})

export type CreateOrderInput = z.output<typeof createOrderSchema>

// An edit names only what it changes; null clears a note, a date and an address. Which of them the order accepts
// depends on its status (OrderEditableFields), which the service checks with orderFieldsOfEdit.
export const updateOrderSchema = z
  .strictObject({
    items: itemsSchema.optional(),
    shippingCents: cents.optional(),
    discountCents: cents.optional(),
    discountReason: priceReasonSchema.nullable().optional(),
    shippingAddress: orderShippingAddressSchema.nullable().optional(),
    recipientPhones: recipientPhonesSchema.optional(),
    scheduledDeliveryDate: scheduledDeliveryDateSchema.nullable().optional(),
    paymentMethod: z.enum(PaymentMethod).optional(),
    customerNotes: customerNotes.nullable().optional(),
    internalNotes: internalNotes.nullable().optional(),
    packingNotes: packingNotes.nullable().optional(),
    trackingNumber: freeText(OrderLimits.TRACKING_NUMBER_MAX_LENGTH).min(1).nullable().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })
  // A discount cannot lose its reason in the same edit
  .refine(body => !(body.discountReason === null && (body.discountCents ?? 0) > 0), {
    message: 'a discount needs its reason'
  })
  // A reason travels with a price: alone it would be a write to a field the status may have locked
  .refine(
    body =>
      body.discountReason === undefined ||
      body.discountCents !== undefined ||
      body.shippingCents !== undefined ||
      body.items !== undefined,
    { message: 'a reason needs a discount, a shipping fee or items' }
  )

export type UpdateOrderInput = z.output<typeof updateOrderSchema>

// The editable fields an edit touches: what the service checks against OrderEditableFields[status]
export function orderFieldsOfEdit(body: UpdateOrderInput): OrderEditableField[] {
  const fields: OrderEditableField[] = []
  if (body.items !== undefined) fields.push('items')
  if (body.shippingCents !== undefined) fields.push('shipping')
  // The reason of a discount is part of it: it cannot be rewritten in a status that locks the discount. (A reason that
  // travels with a fee only is told apart by the service, which knows whether the order has a discount.)
  if (body.discountCents !== undefined) fields.push('discount')
  if (body.shippingAddress !== undefined) fields.push('address')
  if (body.recipientPhones !== undefined) fields.push('recipientPhones')
  if (body.scheduledDeliveryDate !== undefined) fields.push('scheduledDeliveryDate')
  if (body.paymentMethod !== undefined) fields.push('paymentMethod')
  if (body.customerNotes !== undefined) fields.push('customerNotes')
  if (body.internalNotes !== undefined) fields.push('internalNotes')
  if (body.packingNotes !== undefined) fields.push('packingNotes')
  if (body.trackingNumber !== undefined) fields.push('trackingNumber')
  return fields
}

// A change of status (TDD_09 §5.3). The reason is required to cancel, the proof and the moment of delivery belong to
// DELIVERED and the restock choice to RETURNED: a field for another status is refused.
export const changeOrderStatusSchema = z
  .strictObject({
    status: z.enum(OrderStatus),
    // How the customer confirmed (TDD_17 §4.3); the moment it was made at creation is not a way to confirm later
    confirmedVia: z.enum(OrderConfirmationChannel).optional(),
    cancellationReason: freeText(OrderLimits.CANCELLATION_REASON_MAX_LENGTH).optional(),
    proofOfDeliveryMediaId: id.optional(),
    deliveredAt: z.iso.datetime({ offset: true }).optional(),
    restock: z.boolean().optional()
  })
  .superRefine((body, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message })
    if (body.status === OrderStatus.CANCELLED) {
      if (body.cancellationReason === undefined || body.cancellationReason === '') {
        issue('cancellationReason', 'a cancellation needs its reason')
      }
    } else if (body.cancellationReason !== undefined) {
      issue('cancellationReason', 'only a cancellation has a reason')
    }
    if (body.status !== OrderStatus.CONFIRMED && body.confirmedVia !== undefined) {
      issue('confirmedVia', 'only a confirmation says how the customer confirmed')
    }
    if (body.confirmedVia === OrderConfirmationChannel.AT_CREATION) {
      issue('confirmedVia', 'confirming at creation is done when the order is created')
    }
    if (body.status !== OrderStatus.DELIVERED) {
      if (body.proofOfDeliveryMediaId !== undefined)
        issue('proofOfDeliveryMediaId', 'only a delivery has proof')
      if (body.deliveredAt !== undefined)
        issue('deliveredAt', 'only a delivery has a delivery moment')
    }
    if (body.status !== OrderStatus.RETURNED && body.restock !== undefined) {
      issue('restock', 'only a return has a restock choice')
    }
  })

export type ChangeOrderStatusInput = z.output<typeof changeOrderStatusSchema>

// A payment recorded by hand (v1.2): how the money came (it never changes Order.paymentMethod, how the order was sold), in what state, the number of the transfer or deposit and the
// receipt, a file of purpose order uploaded before. COMPLETED needs no reference for cash, which has none; a transfer
// and a card payment should name theirs, which the form asks for and the server does not force.
export const recordOrderPaymentSchema = z.strictObject({
  method: z.enum(PaymentMethod),
  status: z.enum(PaymentStatus),
  reference: freeText(OrderLimits.PAYMENT_REFERENCE_MAX_LENGTH).min(1).optional(),
  proofMediaId: id.optional()
})

export type RecordOrderPaymentInput = z.output<typeof recordOrderPaymentSchema>

// GET /orders, scheduled delivery: inclusive days, or one shortcut, never both; the sort that lists by delivery day.
// Exported as a shape so the list query adds its own keys, plus the check that goes with it: zod does not extend a
// schema that carries a refinement.
export const orderScheduleFilterShape = {
  [OrderScheduleFilters.FROM]: scheduledDeliveryDateSchema.optional(),
  [OrderScheduleFilters.TO]: scheduledDeliveryDateSchema.optional(),
  [OrderScheduleFilters.ON]: z.enum(OrderScheduledDeliveryShortcuts).optional(),
  sort: z.enum(OrderSorts).optional()
}

export function orderScheduleFiltersAreConsistent(
  filters: Partial<Record<(typeof OrderScheduleFilters)[keyof typeof OrderScheduleFilters], string>>
): boolean {
  const from = filters[OrderScheduleFilters.FROM]
  const to = filters[OrderScheduleFilters.TO]
  const on = filters[OrderScheduleFilters.ON]
  if (on !== undefined && (from !== undefined || to !== undefined)) return false
  // 'YYYY-MM-DD' strings sort as days do
  return from === undefined || to === undefined || from <= to
}

// The filters of the orders list that the export takes too (everything but the page and the sort): the text search, the
// state, the payment, the price approval, the customer, and the day the order was made. Exported as a shape for the same
// reason as the schedule one. The sort is the list's alone (`orderSortShape`).
// A day of a filter of the list: a year Postgres can hold and `nextCalendarDay` can add one to (the year 0 or 9999 is a 500,
// not a 400)
const FIRST_FILTER_DAY = '1970-01-01'
const LAST_FILTER_DAY = '2999-12-31'
const filterDaySchema = z.iso
  .date()
  .refine(day => day >= FIRST_FILTER_DAY && day <= LAST_FILTER_DAY, {
    message: 'the day is out of range'
  })

export const orderListFilterShape = {
  [OrderListFilters.Q]: freeText(OrderLimits.SEARCH_MAX_LENGTH).min(1).optional(),
  [OrderListFilters.STATUS]: z.enum(OrderStatus).optional(),
  [OrderListFilters.PAYMENT_STATUS]: z.enum(PaymentStatus).optional(),
  [OrderListFilters.PRICE_APPROVAL_STATUS]: z.enum(PriceApprovalStatus).optional(),
  [OrderListFilters.CUSTOMER_ID]: id.optional(),
  [OrderListFilters.CREATED_FROM]: filterDaySchema.optional(),
  [OrderListFilters.CREATED_TO]: filterDaySchema.optional(),
  [OrderScheduleFilters.FROM]: filterDaySchema.optional(),
  [OrderScheduleFilters.TO]: filterDaySchema.optional(),
  [OrderScheduleFilters.ON]: z.enum(OrderScheduledDeliveryShortcuts).optional()
}

// Both ranges: the first day not after the last, and a shortcut never next to days of the schedule
export function orderListFiltersAreConsistent(filters: {
  scheduledDeliveryFrom?: string
  scheduledDeliveryTo?: string
  scheduledDeliveryOn?: string
  createdFrom?: string
  createdTo?: string
}): boolean {
  const from = filters[OrderListFilters.CREATED_FROM]
  const to = filters[OrderListFilters.CREATED_TO]
  return (
    orderScheduleFiltersAreConsistent(filters) &&
    (from === undefined || to === undefined || from <= to)
  )
}

// The sort of the list alone: the export has no order to keep
export const orderSortShape = { [OrderListFilters.SORT]: z.enum(OrderSorts).optional() }
