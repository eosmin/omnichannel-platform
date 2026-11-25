import { z } from 'zod'

import {
  ChoosableCookieCategories,
  ComplianceConfig,
  ConsentPurposes,
  COOKIE_POLICY_VERSION,
  dsrIntakeSchema
} from '@platform/core/compliance'
import {
  DSR_REQUEST_KEY_MAX_LENGTH,
  DSR_REQUEST_KEY_MIN_LENGTH,
  DSR_VERIFY_TOKEN_PATTERN,
  DsrStatus,
  DsrType,
  lowercasedUuidSchema,
  multiLineText,
  queryIntSchema
} from '@platform/core/domain'

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

// The public form of data requests (Step 7.2-H1): the key of the store the form belongs to, what is asked, where the link goes and in
// which language. Nothing else is read from the body.
export const dsrIntakeBodySchema = dsrIntakeSchema.strict()
export type DsrIntakeBody = z.infer<typeof dsrIntakeBodySchema>

// The token of the mail: 256 bits in base64url (43 characters)
export const dsrVerifyBodySchema = z
  .object({ token: z.string().regex(DSR_VERIFY_TOKEN_PATTERN) })
  .strict()
export type DsrVerifyBody = z.infer<typeof dsrVerifyBodySchema>

// The token of the link of the closing mail that hands over the file of an access or portability request: the same 256 bits in base64url
export const dsrExportDownloadBodySchema = z
  .object({ token: z.string().regex(DSR_VERIFY_TOKEN_PATTERN) })
  .strict()
export type DsrExportDownloadBody = z.infer<typeof dsrExportDownloadBodySchema>

// The review queue of the data requests (Step 7.2-H1b). What a reviewer types is free text about a person: it is kept in the row and is
// never copied to the audit log or a log line.
const reviewReasonSchema = multiLineText(ComplianceConfig.DSR_REVIEW_REASON_MAX_LENGTH, 1)

// Approving is a written decision: the box is ticked and the reason is given
export const dsrApproveBodySchema = z
  .object({ confirm: z.literal(true), reason: reviewReasonSchema })
  .strict()
export type DsrApproveBody = z.infer<typeof dsrApproveBodySchema>

export const dsrDecisionBodySchema = z.object({ reason: reviewReasonSchema }).strict()
export type DsrDecisionBody = z.infer<typeof dsrDecisionBodySchema>

export const listDsrQuerySchema = z
  .object({
    status: z.enum(DsrStatus).optional(),
    type: z.enum(DsrType).optional(),
    limit: queryIntSchema(1, ComplianceConfig.DSR_REVIEW_MAX_PAGE_SIZE).default(
      ComplianceConfig.DSR_REVIEW_PAGE_SIZE
    ),
    cursor: lowercasedUuidSchema.optional()
  })
  .strict()
export type ListDsrQuery = z.infer<typeof listDsrQuerySchema>

// The key of the public form (Step 7.2-H2b, C1a). `current` is the key the screen was showing (null when it showed none): the change is made
// only if the store still holds that one, so two admins who press at once do not replace each other's key without knowing.
export const dsrFormKeyBodySchema = z
  .object({
    current: z.string().min(DSR_REQUEST_KEY_MIN_LENGTH).max(DSR_REQUEST_KEY_MAX_LENGTH).nullable()
  })
  .strict()
export type DsrFormKeyBody = z.infer<typeof dsrFormKeyBodySchema>
