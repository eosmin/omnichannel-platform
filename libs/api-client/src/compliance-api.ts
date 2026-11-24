import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { COOKIE_POLICY_VERSION, type ChoosableCookieCategory } from '@platform/core/cookie-consent'

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
