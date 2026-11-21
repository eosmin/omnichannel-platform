import { z } from 'zod'

import {
  ChoosableCookieCategories,
  ConsentPurposes,
  COOKIE_POLICY_VERSION
} from '@platform/core/compliance'
import { lowercasedUuidSchema } from '@platform/core/domain'

const purposeSchema = z.enum(Object.values(ConsentPurposes) as [string, ...string[]])

export const recordConsentSchema = z
  .object({
    customerId: lowercasedUuidSchema,
    purpose: purposeSchema,
    granted: z.boolean()
  })
  .strict()
export type RecordConsentBody = z.infer<typeof recordConsentSchema>

export const listConsentQuerySchema = z.object({ customerId: lowercasedUuidSchema }).strict()
export type ListConsentQuery = z.infer<typeof listConsentQuerySchema>

// The id the browser made for itself: a random UUID that says nothing about the person. Lower-cased, so one id is one key.
const visitorIdSchema = z.uuid().transform(value => value.toLowerCase())

const categoriesShape = Object.fromEntries(
  ChoosableCookieCategories.map(category => [category, z.boolean()])
) as Record<(typeof ChoosableCookieCategories)[number], z.ZodBoolean>

export const cookieConsentSchema = z
  .object({
    visitorId: visitorIdSchema,
    // Every choosable category is answered: a missing one is not a "no", it is a banner that did not show it
    categories: z.object(categoriesShape).strict(),
    // The version the person saw. One the server does not know is refused and never recorded as the current one: it would
    // say the person agreed to a policy they were not shown
    policyVersion: z.literal(COOKIE_POLICY_VERSION)
  })
  .strict()
export type CookieConsentBody = z.infer<typeof cookieConsentSchema>
