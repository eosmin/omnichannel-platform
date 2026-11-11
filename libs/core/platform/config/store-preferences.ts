import { z } from 'zod'

import { FailedAttemptMessagePolicy, OrderFreeShippingRules } from '@platform/core/domain'

// Imported as '@platform/core/store-preferences', not through the config barrel, which the lint rule
// keeps to the libraries that read the env.
//
// What a store may change without a deploy, kept in StoreSettings.preferences (a Json column).
// This file is the only place of the factory defaults: a key missing from the column reads as the
// default here, so adding a key needs no migration. It holds the keys that exist today; Step 4.14
// grows it into the full schema of TDD_17 §4.14. GET and PUT /settings/preferences (Step 3.6) are built
// over it and take the new keys as they are added.
//
// Each key falls back to its own default (`catch`): a value that does not fit in one key must not reset
// the others, least of all a switch the store turned off.
export const storePreferencesSchema = z.object({
  // A store may read a conversation without telling the customer (blue ticks); on by default
  sendReadReceipts: z.boolean().catch(true),
  // The first reply of an agent who may assign, to a conversation nobody has, gives it to them; on by
  // default, in the stores that already exist too (a key that is missing reads as this)
  assignOnReply: z.boolean().catch(true)
})

export type StorePreferences = z.output<typeof storePreferencesSchema>

// The column is written by the api, but a value that does not fit (edited by hand, or left by an older
// version) reads as the defaults rather than failing the request that asked
export function readStorePreferences(raw: unknown): StorePreferences {
  const parsed = storePreferencesSchema.safeParse(raw)
  return parsed.success ? parsed.data : storePreferencesSchema.parse({})
}

// What PUT /settings/preferences takes: the keys the caller changes, each held to its real type (the
// `catch` above is for reading what is stored, never for accepting what a client sends). Keys that are
// not named keep their value, so a page that draws only some of them cannot reset the others.
export const updateStorePreferencesSchema = z
  .strictObject({
    sendReadReceipts: z.boolean().optional(),
    assignOnReply: z.boolean().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type UpdateStorePreferencesBody = z.output<typeof updateStorePreferencesSchema>

// The `orders` block of the preferences (TDD_17 §4.14), the keys the orders and shipments read today: Step 4.14 grows it into the
// whole block and adds its write path, and then it joins `storePreferencesSchema`. It is read apart from it on purpose:
// a nested object in StorePreferences would make every PUT of the flat keys look like a change of `orders` (the audit of
// the update compares the keys it returns by identity). Each key falls back to its own default.
export const orderPreferencesSchema = z.object({
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
    .catch(FailedAttemptMessagePolicy.EVERY_ATTEMPT)
})

export type OrderPreferences = z.output<typeof orderPreferencesSchema>

export function readOrderPreferences(raw: unknown): OrderPreferences {
  const block =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['orders']
      : undefined
  const parsed = orderPreferencesSchema.safeParse(
    typeof block === 'object' && block !== null && !Array.isArray(block) ? block : {}
  )
  return parsed.success ? parsed.data : orderPreferencesSchema.parse({})
}
