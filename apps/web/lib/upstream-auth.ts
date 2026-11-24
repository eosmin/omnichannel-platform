import { z } from 'zod'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'

import { webEnv } from './env'

// What the api's refresh and consume answer with (IssuedSession); the refresh token is read here and
// goes into the cookie, never into the answer to the browser.
export const issuedSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
  refreshExpiresAt: z.iso.datetime()
})
export type IssuedSession = z.output<typeof issuedSessionSchema>

const UPSTREAM_TIMEOUT_MS = 10_000

export const consumedLoginSchema = z.object({ session: issuedSessionSchema })

export const acceptedInvitationUpstreamSchema = z.object({
  store: z.object({ id: z.string(), name: z.string() }),
  role: z.string(),
  session: issuedSessionSchema.optional()
})

export const AuthUpstreamPaths = {
  consume: ApiRoutes.auth.magicLinkConsume,
  refresh: ApiRoutes.auth.refresh,
  logout: ApiRoutes.auth.logout,
  acceptInvitation: (token: string) => ApiRoutes.invitations.accept(encodeURIComponent(token))
} as const

// The api counts its rate limits and shows the sessions by client, so it is told which client this
// is, not the Next server that stands in between
export function clientHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  const userAgent = request.headers.get('user-agent')
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (userAgent !== null) headers['user-agent'] = userAgent
  if (forwardedFor !== null) headers['x-forwarded-for'] = forwardedFor
  return headers
}

export function callApi(
  path: string,
  options: { body?: unknown; accessToken?: string; client: Record<string, string> }
): Promise<Response> {
  const headers: Record<string, string> = { ...options.client }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.accessToken !== undefined) headers.authorization = `Bearer ${options.accessToken}`
  return fetch(`${webEnv.NEXT_PUBLIC_API_URL}${API_PREFIX}${path}`, {
    method: 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) // A hung api must not hold the handler open
  })
}
