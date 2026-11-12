import { z } from 'zod'

import {
  FailedAttemptMessagePolicy,
  OrderCancellationReasons,
  OrderFreeShippingRules
} from '@platform/core/domain'

// Imported as '@platform/core/store-preferences', not through the config barrel, which the lint rule
// keeps to the libraries that read the env.
//
// What a store may change without a deploy, kept in StoreSettings.preferences (a Json column).
// This file is the only place of the factory defaults: a key missing from the column reads as the
// default here, so adding a key needs no migration. GET and PUT /settings/preferences are built over
// it and take the new keys as they are added; the `orders` block holds the keys of TDD_17 §4.14 that exist today.
//
// The `orders` block of the preferences (TDD_17 §4.14). Each key falls back to its own default, so a value that does not
// fit in one key resets that key only.
//
// A reason is either a factory one (`labelKey`, an i18n key) or one the store typed (`label`, store content and not a UI
// string): exactly one of the two. `Order.cancellationReason` keeps a snapshot of the text, never the id, so renaming or
// removing a reason later does not change old orders.
export const CancellationReasonLimits = {
  MAX_ENTRIES: 30,
  MAX_ID_LENGTH: 40,
  MAX_LABEL_LENGTH: 80
} as const

const cancellationReasonShape = z
  .object({
    id: z.string().trim().min(1).max(CancellationReasonLimits.MAX_ID_LENGTH),
    labelKey: z.string().min(1).optional(),
    label: z.string().trim().min(1).max(CancellationReasonLimits.MAX_LABEL_LENGTH).optional()
  })
  .refine(reason => (reason.labelKey === undefined) !== (reason.label === undefined), {
    message: 'exactly one of labelKey and label'
  })

// A factory `labelKey` must be one the product ships (the dialog translates it); a key of the store's own is a `label`
const cancellationReasonSchema = cancellationReasonShape.refine(
  reason =>
    reason.labelKey === undefined ||
    (Object.values(OrderCancellationReasons) as string[]).includes(reason.labelKey),
  { message: 'unknown labelKey', path: ['labelKey'] }
)

export const cancellationReasonsSchema = z
  .array(cancellationReasonSchema)
  .min(1)
  .max(CancellationReasonLimits.MAX_ENTRIES)
  .refine(list => new Set(list.map(reason => reason.id)).size === list.length, {
    message: 'duplicate id'
  })
  // Two entries that read the same would be two identical options of the dialog and two snapshots nobody can tell apart
  .refine(
    list => {
      const texts = list.map(reason => (reason.labelKey ?? reason.label ?? '').toLowerCase())
      return new Set(texts).size === texts.length
    },
    { message: 'duplicate reason' }
  )

export type CancellationReason = z.output<typeof cancellationReasonSchema>

// The factory list, seeded from OrderCancellationReasons: the id is the name of the constant
export const defaultCancellationReasons: CancellationReason[] = Object.entries(
  OrderCancellationReasons
).map(([id, labelKey]) => ({ id, labelKey }))

export const orderPreferencesSchema = z.object({
  // The create-order "Mark as confirmed" checkbox starts as this (TDD_17 §4.3): unchecked until the owner wants orders
  // confirmed as they are created
  confirmOnCreate: z.boolean().catch(false),
  // The create-order "Send the order summary" checkbox starts as this, and it decides whether the summary goes out
  // when an order is created (TDD_17 §4.7): the summary template has no `autoSend` of its own
  sendSummaryOnCreate: z.boolean().catch(true),
  // The discount allowed without approval to a member lacking ORDERS_OVERRIDE_PRICE, as a percent of the subtotal:
  // none until the owner allows some
  discountLimitPercent: z.number().int().min(0).max(100).catch(0),
  // The approvers are told when a member with the override sets a price (TDD_17 §4.13)
  notifyOnPriceOverride: z.boolean().catch(true),
  // When an order counts as free shipping (TDD_17 §4.13)
  freeShippingRule: z.enum(OrderFreeShippingRules).catch(OrderFreeShippingRules.ALL_ITEMS),
  // How often the customer is told that a delivery attempt failed (TDD_17 §4.7): a carrier tries up to three times, and
  // the customer should not get three identical messages unless the owner wants them
  failedAttemptMessages: z
    .enum(FailedAttemptMessagePolicy)
    .catch(FailedAttemptMessagePolicy.EVERY_ATTEMPT),
  // The dropdown of the cancel dialog (TDD_09 §5.3)
  cancellationReasons: cancellationReasonsSchema.catch(defaultCancellationReasons)
})

export type OrderPreferences = z.output<typeof orderPreferencesSchema>

// What PUT /settings/preferences takes for the `orders` block: only the keys Settings → Preferences draws today. The
// others (discount limit, free shipping rule, failed-attempt policy, price-override notice) are read from the column but
// are written by the page of Step 4.14 that draws them. Each key is held to its real type.
export const updateOrderPreferencesSchema = z
  .strictObject({
    confirmOnCreate: z.boolean().optional(),
    sendSummaryOnCreate: z.boolean().optional(),
    cancellationReasons: cancellationReasonsSchema.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type UpdateOrderPreferencesBody = z.output<typeof updateOrderPreferencesSchema>

// The `returns` block of the preferences (TDD_17 §4.16). Read here and written by the Settings → Returns page of Step 4.14.
export const returnPreferencesSchema = z.object({
  // A package scanned with the reason "refused by the customer" has the reception "flag customer" toggle preselected
  preselectCautionOnRefusal: z.boolean().catch(false)
})

export type ReturnPreferences = z.output<typeof returnPreferencesSchema>

// The `remittances` block (TDD_17 §4.15): when the cash a carrier collected on delivery is late. The daily check tells the team
// about a connection with shipments delivered longer ago than this and still unpaid.
export const RemittancePreferenceLimits = {
  MIN_OVERDUE_DAYS: 1,
  MAX_OVERDUE_DAYS: 90,
  DEFAULT_OVERDUE_DAYS: 7
} as const

// The accepted range, written once: what the api takes is held to it, and a stored value that does not fit reads as the default
const overdueAfterDaysField = z
  .number()
  .int()
  .min(RemittancePreferenceLimits.MIN_OVERDUE_DAYS)
  .max(RemittancePreferenceLimits.MAX_OVERDUE_DAYS)

export const remittancePreferencesSchema = z.object({
  overdueAfterDays: overdueAfterDaysField.catch(RemittancePreferenceLimits.DEFAULT_OVERDUE_DAYS)
})

export type RemittancePreferences = z.output<typeof remittancePreferencesSchema>

export const updateRemittancePreferencesSchema = z
  .strictObject({ overdueAfterDays: overdueAfterDaysField.optional() })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type UpdateRemittancePreferencesBody = z.output<typeof updateRemittancePreferencesSchema>

// Each key falls back to its own default (`catch`): a value that does not fit in one key must not reset
// the others, least of all a switch the store turned off.
export const storePreferencesSchema = z.object({
  // A store may read a conversation without telling the customer (blue ticks); on by default
  sendReadReceipts: z.boolean().catch(true),
  // The first reply of an agent who may assign, to a conversation nobody has, gives it to them; on by
  // default, in the stores that already exist too (a key that is missing reads as this)
  assignOnReply: z.boolean().catch(true),
  // The orders block (TDD_17 §4.14); a column with none reads as every default of the block
  orders: orderPreferencesSchema.catch(() => orderPreferencesSchema.parse({})),
  // The returns block (TDD_17 §4.16); a column with none reads as every default of the block
  returns: returnPreferencesSchema.catch(() => returnPreferencesSchema.parse({})),
  // The remittances block (TDD_17 §4.15); a column with none reads as every default of the block
  remittances: remittancePreferencesSchema.catch(() => remittancePreferencesSchema.parse({}))
})

export type StorePreferences = z.output<typeof storePreferencesSchema>

// The column is written by the api, but a value that does not fit (edited by hand, or left by an older
// version) reads as the defaults rather than failing the request that asked
export function readStorePreferences(raw: unknown): StorePreferences {
  const parsed = storePreferencesSchema.safeParse(raw)
  return parsed.success ? parsed.data : storePreferencesSchema.parse({})
}

export function readOrderPreferences(raw: unknown): OrderPreferences {
  return readStorePreferences(raw).orders
}

export function readRemittancePreferences(raw: unknown): RemittancePreferences {
  return readStorePreferences(raw).remittances
}

// What PUT /settings/preferences takes: the keys the caller changes, each held to its real type (the
// `catch` above is for reading what is stored, never for accepting what a client sends). Keys that are
// not named keep their value, so a page that draws only some of them cannot reset the others. The `orders`
// block is merged key by key too.
export const updateStorePreferencesSchema = z
  .strictObject({
    sendReadReceipts: z.boolean().optional(),
    assignOnReply: z.boolean().optional(),
    orders: updateOrderPreferencesSchema.optional(),
    remittances: updateRemittancePreferencesSchema.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type UpdateStorePreferencesBody = z.output<typeof updateStorePreferencesSchema>
