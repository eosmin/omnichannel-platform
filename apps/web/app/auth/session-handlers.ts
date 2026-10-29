import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { isProduction } from '../../lib/env'
import { refreshCookie, refreshCookieName } from '../../lib/refresh-cookie'
import { isSameOrigin } from '../../lib/same-origin'
import {
  acceptedInvitationUpstreamSchema,
  AuthUpstreamPaths,
  callApi,
  clientHeaders,
  consumedLoginSchema,
  type IssuedSession,
  issuedSessionSchema
} from '../../lib/upstream-auth'

const MAX_TOKEN_LENGTH = 200 // As the api: only keeps a hostile body from being forwarded
const consumeBodySchema = z.object({ token: z.string().min(1).max(MAX_TOKEN_LENGTH) })
const MAX_NAME_LENGTH = 100
const acceptBodySchema = z.object({
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional()
})
const BEARER_PREFIX = 'Bearer '

// Same shape as the api's errors, so that the client reads one contract
function failure(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { error: { code, message, metadata: {} }, correlationId: crypto.randomUUID() },
    { status, headers: { 'cache-control': 'no-store' } }
  )
}

// An expired cookie with the attributes it was set with: a __Host- cookie is only accepted (and so
// only deleted) when the Set-Cookie says Secure
function clearCookie(response: NextResponse): NextResponse {
  response.cookies.set(refreshCookie('', new Date(0), isProduction))
  return response
}

// A session starts or continues: the refresh token goes into the cookie, the browser gets the
// access token and nothing else
function sessionResponse(issued: IssuedSession, extra: object = {}): NextResponse {
  const response = NextResponse.json(
    { ...extra, accessToken: issued.accessToken, expiresIn: issued.expiresIn },
    { headers: { 'cache-control': 'no-store' } }
  )
  response.cookies.set(
    refreshCookie(issued.refreshToken, new Date(issued.refreshExpiresAt), isProduction)
  )
  return response
}

// The api refused: its answer goes through as it came. Only for a refresh does a 401 mean that the
// session is over; a bad magic link must not end the session of someone who is already signed in.
async function refused(upstream: Response, endsSession: boolean): Promise<NextResponse> {
  const response = new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
  return endsSession && upstream.status === HttpStatusCodes.UNAUTHORIZED
    ? clearCookie(response)
    : response
}

// A body that is not what the api promises (an error page of a proxy) is treated as an api that
// cannot be reached: the cookie stays as it was
async function readJson<T>(
  upstream: Response,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }
): Promise<T | null> {
  const parsed = schema.safeParse(await upstream.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

function crossSite(request: NextRequest): NextResponse | null {
  return isSameOrigin(
    request.headers.get('origin'),
    request.headers.get('host'),
    request.headers.get('x-forwarded-host')
  )
    ? null
    : failure(HttpStatusCodes.FORBIDDEN, ErrorCodes.PERMISSION_DENIED, 'Cross-site request')
}

const unreachable = (): NextResponse =>
  failure(
    HttpStatusCodes.INTERNAL_SERVER_ERROR,
    ErrorCodes.INTERNAL_ERROR,
    'The api cannot be reached'
  )

// Trades the token of a magic link for a session
export async function consumeSession(request: NextRequest): Promise<NextResponse> {
  const blocked = crossSite(request)
  if (blocked !== null) return blocked
  const body = consumeBodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return failure(
      HttpStatusCodes.BAD_REQUEST,
      ErrorCodes.VALIDATION_INVALID_INPUT,
      'A token is required'
    )
  }
  const upstream = await callApi(AuthUpstreamPaths.consume, {
    body: body.data,
    client: clientHeaders(request)
  }).catch(() => null)
  if (upstream === null) return unreachable()
  if (!upstream.ok) return refused(upstream, false)
  const login = await readJson(upstream, consumedLoginSchema)
  return login === null ? unreachable() : sessionResponse(login.session)
}

// The refresh token rotates on every use: the answer carries the next one, which replaces the cookie
export async function refreshSession(request: NextRequest): Promise<NextResponse> {
  const blocked = crossSite(request)
  if (blocked !== null) return blocked
  const refreshToken = request.cookies.get(refreshCookieName(isProduction))?.value
  if (refreshToken === undefined) {
    return failure(
      HttpStatusCodes.UNAUTHORIZED,
      ErrorCodes.AUTH_UNAUTHORIZED,
      'There is no session'
    )
  }
  const upstream = await callApi(AuthUpstreamPaths.refresh, {
    body: { refreshToken },
    client: clientHeaders(request)
  }).catch(() => null)
  if (upstream === null) return unreachable()
  if (!upstream.ok) return refused(upstream, true)
  const issued = await readJson(upstream, issuedSessionSchema)
  return issued === null ? unreachable() : sessionResponse(issued)
}

// Ends the family on the api and clears the cookie. The access token may have expired, so the
// cookie is traded for a fresh one first. If the session cannot be rotated it is already dead and the
// cookie goes; if the logout itself fails, the session stays (see below) and the person is told.
export async function endSession(request: NextRequest): Promise<NextResponse> {
  const blocked = crossSite(request)
  if (blocked !== null) return blocked
  const done = (): NextResponse =>
    clearCookie(new NextResponse(null, { status: HttpStatusCodes.NO_CONTENT }))
  const refreshToken = request.cookies.get(refreshCookieName(isProduction))?.value
  if (refreshToken === undefined) return done()
  const client = clientHeaders(request)
  const rotated = await callApi(AuthUpstreamPaths.refresh, {
    body: { refreshToken },
    client
  }).catch(() => null)
  if (rotated?.ok !== true) return done()
  const issued = await readJson(rotated, issuedSessionSchema)
  if (issued === null) return done()
  const loggedOut = await callApi(AuthUpstreamPaths.logout, {
    accessToken: issued.accessToken,
    client
  }).catch(() => null)
  if (loggedOut?.ok === true) return done()
  // The family is still alive on the api and the old refresh token is spent: keep the new one in the
  // cookie so that the session is not lost and the person can try again, and say that it failed
  const failed = unreachable()
  failed.cookies.set(
    refreshCookie(issued.refreshToken, new Date(issued.refreshExpiresAt), isProduction)
  )
  return failed
}

// Accepts an invitation. A person with a session sends their access token, which goes to the api as
// it came; a person with no account gets one here, and the session the api opens for it is handled
// like any other: the cookie is set and the browser gets the access token only.
export async function acceptInvitation(request: NextRequest): Promise<NextResponse> {
  const blocked = crossSite(request)
  if (blocked !== null) return blocked
  const body = acceptBodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return failure(
      HttpStatusCodes.BAD_REQUEST,
      ErrorCodes.VALIDATION_INVALID_INPUT,
      'A token is required'
    )
  }
  const authorization = request.headers.get('authorization')
  const upstream = await callApi(AuthUpstreamPaths.acceptInvitation(body.data.token), {
    body: body.data.name === undefined ? {} : { name: body.data.name },
    accessToken: authorization?.startsWith(BEARER_PREFIX)
      ? authorization.slice(BEARER_PREFIX.length)
      : undefined,
    client: clientHeaders(request)
  }).catch(() => null)
  if (upstream === null) return unreachable()
  if (!upstream.ok) return refused(upstream, false)
  const accepted = await readJson(upstream, acceptedInvitationUpstreamSchema)
  if (accepted === null) return unreachable()
  const { session, ...result } = accepted
  return session === undefined
    ? NextResponse.json(result, { headers: { 'cache-control': 'no-store' } })
    : sessionResponse(session, result)
}
