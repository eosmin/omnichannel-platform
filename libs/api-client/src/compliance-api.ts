import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { COOKIE_POLICY_VERSION, type ChoosableCookieCategory } from '@platform/core/cookie-consent'
import { DsrType } from '@platform/core/domain'
import type { Locale } from '@platform/core/i18n'

import type { ApiClient } from './api-client'

// What the api answers to the choice of the cookie banner: true when a row was written, false when the newest row of the
// visitor already said the same
export const cookieConsentResultSchema = z.object({ recorded: z.boolean() })
export type CookieConsentResult = z.infer<typeof cookieConsentResultSchema>

export interface CookieConsentChoice {
  // The random id the browser made for itself; it says nothing about the person
  visitorId: string
  categories: Record<ChoosableCookieCategory, boolean>
}

// Public route: the choice of a visitor who may have no account. It sends no token, so it never asks for a refresh and a
// browser with no session records the choice as an anonymous one.
export function recordCookieConsent(
  client: ApiClient,
  choice: CookieConsentChoice,
  signal?: AbortSignal
): Promise<CookieConsentResult> {
  return client.request(ApiRoutes.compliance.cookieConsent, {
    method: 'POST',
    body: { ...choice, policyVersion: COOKIE_POLICY_VERSION },
    schema: cookieConsentResultSchema,
    authenticated: false,
    signal
  })
}

// The confirmation of a public data request (Step 7.2-H1a route, C1b page). Public: no session and no store, so it never asks for a refresh.
// The token is in the body, never in the URL of this request. One answer for every token that does not hold (unknown, used, expired, a request
// that no longer waits, the flow off): the page cannot tell them apart and says so in one sentence
export const dsrVerifyResultSchema = z.object({ verified: z.literal(true) })

export function verifyDsrRequest(
  client: ApiClient,
  token: string,
  signal?: AbortSignal
): Promise<z.infer<typeof dsrVerifyResultSchema>> {
  return client.request(ApiRoutes.compliance.dsrVerify, {
    method: 'POST',
    body: { token },
    schema: dsrVerifyResultSchema,
    authenticated: false,
    signal
  })
}

// The exchange of the link of the closing mail of an access or portability request for the signed link to the file (Step 7.2-H2b-3a route,
// H2b-3b page). Public: no session and no store. The token is in the body, never in the URL. The signed link lives `expiresInSeconds` and is
// only ever kept in memory: it is a bearer link to the person's data, so it must be http(s) (a `javascript:` or `data:` address is refused)
export const dsrExportDownloadResultSchema = z.object({
  url: z
    .string()
    .url()
    .refine(value => ['https:', 'http:'].includes(new URL(value).protocol)),
  filename: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  // The password of the ZIP (H2b-3c): shown once and kept only in memory. Required: an answer without it is a file the person cannot open, so it
  // is refused here and the page never presents it as a success
  password: z.string().min(1)
})
export type DsrExportDownloadResult = z.infer<typeof dsrExportDownloadResultSchema>

export function downloadDsrExport(
  client: ApiClient,
  token: string,
  signal?: AbortSignal
): Promise<DsrExportDownloadResult> {
  return client.request(ApiRoutes.compliance.dsrExportDownload, {
    method: 'POST',
    body: { token },
    schema: dsrExportDownloadResultSchema,
    authenticated: false,
    signal
  })
}

// The kinds of request the public form offers. The api takes more (`DsrType`): these are the ones a person can ask for without an account and
// that the store answers by mail after a review (the others need a conversation with the store)
export const DSR_PUBLIC_TYPES = [DsrType.ACCESS, DsrType.ERASURE, DsrType.PORTABILITY] as const
export type DsrPublicType = (typeof DSR_PUBLIC_TYPES)[number]

export interface DsrRequestInput {
  // The key of the store, read from the fragment of the address of the form
  storeKey: string
  type: DsrPublicType
  email: string
  locale: Locale
}

// The answer of a public data request is ALWAYS the same 202: it never says whether the address belongs to a customer, and the rate limit counts
// every address alike. Public: no session and no store, so it never asks for a refresh.
export const dsrRequestResultSchema = z.object({ accepted: z.literal(true) })

export function submitDsrRequest(
  client: ApiClient,
  input: DsrRequestInput,
  signal?: AbortSignal
): Promise<z.infer<typeof dsrRequestResultSchema>> {
  return client.request(ApiRoutes.compliance.dsr, {
    method: 'POST',
    body: input,
    schema: dsrRequestResultSchema,
    authenticated: false,
    signal
  })
}
