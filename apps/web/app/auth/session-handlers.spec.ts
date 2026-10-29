import { NextRequest } from 'next/server'

import { consumeSession, endSession, refreshSession } from './session-handlers'

jest.mock('../../lib/env', () => ({
  isProduction: false,
  webEnv: { NEXT_PUBLIC_API_URL: 'https://api.example.com' }
}))

const HOST = 'app.example.com'
const COOKIE = 'platform_refresh'

const issued = {
  accessToken: 'access-2',
  refreshToken: 'refresh-2',
  tokenType: 'Bearer',
  expiresIn: 900,
  refreshExpiresAt: '2026-11-28T10:00:00.000Z'
}
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const apiError = (code: string): unknown => ({
  error: { code, message: code, metadata: {} },
  correlationId: 'c-1'
})

function post(
  path: string,
  options: { body?: unknown; cookie?: string; origin?: string | null } = {}
): NextRequest {
  const headers: Record<string, string> = {
    host: HOST,
    'user-agent': 'jest',
    'x-forwarded-for': '1.2.3.4'
  }
  const origin = options.origin === undefined ? `https://${HOST}` : options.origin
  if (origin !== null) headers.origin = origin
  if (options.cookie !== undefined) headers.cookie = `${COOKIE}=${options.cookie}`
  return new NextRequest(`https://${HOST}${path}`, {
    method: 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
}

const fetchMock = jest.spyOn(globalThis, 'fetch')
afterEach(() => {
  fetchMock.mockReset()
})

function lastApiCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)
  if (call === undefined) throw new Error('the api was not called')
  return { url: call[0] as string, init: call[1] ?? {} }
}

describe('refreshSession', () => {
  it('rotates the cookie and gives the browser the access token only', async () => {
    fetchMock.mockResolvedValue(json(200, issued))
    const response = await refreshSession(post('/auth/refresh', { cookie: 'refresh-1' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accessToken: 'access-2', expiresIn: 900 })
    const cookie = response.cookies.get(COOKIE)
    expect(cookie).toMatchObject({ value: 'refresh-2', httpOnly: true, sameSite: 'lax', path: '/' })
    expect(cookie?.expires).toEqual(new Date(issued.refreshExpiresAt))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const { url, init } = lastApiCall()
    expect(url).toBe('https://api.example.com/api/v1/auth/refresh')
    expect(init.body).toBe('{"refreshToken":"refresh-1"}')
  })

  it('tells the api which client this is', async () => {
    fetchMock.mockResolvedValue(json(200, issued))
    await refreshSession(post('/auth/refresh', { cookie: 'refresh-1' }))
    expect(lastApiCall().init.headers).toMatchObject({
      'user-agent': 'jest',
      'x-forwarded-for': '1.2.3.4'
    })
  })

  it('answers 401 without calling the api when there is no cookie', async () => {
    const response = await refreshSession(post('/auth/refresh'))
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears the cookie when the api says the session is over', async () => {
    fetchMock.mockResolvedValue(json(401, apiError('AUTH_REFRESH_TOKEN_REUSED')))
    const response = await refreshSession(post('/auth/refresh', { cookie: 'old' }))
    expect(response.status).toBe(401)
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'AUTH_REFRESH_TOKEN_REUSED' }
    })
    expect(response.cookies.get(COOKIE)?.value).toBe('')
  })

  it('keeps the cookie when the api is limiting or failing', async () => {
    fetchMock.mockResolvedValue(json(429, apiError('RATE_LIMIT_EXCEEDED')))
    const limited = await refreshSession(post('/auth/refresh', { cookie: 'c' }))
    expect(limited.status).toBe(429)
    expect(limited.cookies.get(COOKIE)).toBeUndefined()

    fetchMock.mockRejectedValue(new TypeError('network'))
    const down = await refreshSession(post('/auth/refresh', { cookie: 'c' }))
    expect(down.status).toBe(500)
    expect(down.cookies.get(COOKIE)).toBeUndefined()
  })

  it('keeps the cookie when the answer is not a session', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))
    const response = await refreshSession(post('/auth/refresh', { cookie: 'c' }))
    expect(response.status).toBe(500)
    expect(response.cookies.get(COOKIE)).toBeUndefined()
  })

  it('refuses a request from another site, and one with no origin', async () => {
    const other = await refreshSession(
      post('/auth/refresh', { cookie: 'c', origin: 'https://evil.example.com' })
    )
    const none = await refreshSession(post('/auth/refresh', { cookie: 'c', origin: null }))
    expect([other.status, none.status]).toEqual([403, 403])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('consumeSession', () => {
  it('trades the token for a session and sets the cookie', async () => {
    fetchMock.mockResolvedValue(
      json(200, { session: issued, user: { id: 'u', email: 'a@b.c', name: 'A' } })
    )
    const response = await consumeSession(post('/auth/consume', { body: { token: 'magic' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accessToken: 'access-2', expiresIn: 900 })
    expect(response.cookies.get(COOKIE)?.value).toBe('refresh-2')
    expect(lastApiCall().init.body).toBe('{"token":"magic"}')
  })

  it('does not end the session of someone signed in when a link is refused', async () => {
    fetchMock.mockResolvedValue(json(401, apiError('AUTH_TOKEN_INVALID')))
    const response = await consumeSession(
      post('/auth/consume', { body: { token: 'stale' }, cookie: 'refresh-1' })
    )
    expect(response.status).toBe(401)
    expect(response.cookies.get(COOKIE)).toBeUndefined()
  })

  it('treats an answer that is not a session as an api that cannot be reached', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))
    const response = await consumeSession(post('/auth/consume', { body: { token: 'magic' } }))
    expect(response.status).toBe(500)
    expect(response.cookies.get(COOKIE)).toBeUndefined()
  })

  it('passes a refused token through and sets no cookie', async () => {
    fetchMock.mockResolvedValue(json(401, apiError('AUTH_TOKEN_INVALID')))
    const response = await consumeSession(post('/auth/consume', { body: { token: 'bad' } }))
    expect(response.status).toBe(401)
    expect(response.cookies.get(COOKIE)?.value ?? '').toBe('')
  })

  it('rejects a body without a token before calling the api', async () => {
    const response = await consumeSession(post('/auth/consume', { body: { nope: 1 } }))
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a request from another site', async () => {
    const response = await consumeSession(
      post('/auth/consume', { body: { token: 't' }, origin: 'https://evil.example.com' })
    )
    expect(response.status).toBe(403)
  })
})

describe('endSession', () => {
  it('rotates for a fresh access token, logs out on the api and clears the cookie', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, issued))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const response = await endSession(post('/auth/logout', { cookie: 'refresh-1' }))
    expect(response.status).toBe(204)
    expect(response.cookies.get(COOKIE)?.value).toBe('')
    const { url, init } = lastApiCall()
    expect(url).toBe('https://api.example.com/api/v1/auth/logout')
    expect(init.headers).toMatchObject({ authorization: 'Bearer access-2' })
  })

  it('clears the cookie when the session cannot be rotated, since it is dead already', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'))
    const response = await endSession(post('/auth/logout', { cookie: 'refresh-1' }))
    expect(response.status).toBe(204)
    expect(response.cookies.get(COOKIE)?.value).toBe('')
  })

  it('keeps the rotated session and reports a failure when the logout does not go through', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, issued))
      .mockRejectedValueOnce(new TypeError('network'))
    const response = await endSession(post('/auth/logout', { cookie: 'refresh-1' }))
    expect(response.status).toBe(500)
    expect(response.cookies.get(COOKIE)?.value).toBe('refresh-2')
  })

  it('clears the cookie when the refresh answer is not a session', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))
    const response = await endSession(post('/auth/logout', { cookie: 'c' }))
    expect(response.status).toBe(204)
    expect(response.cookies.get(COOKIE)?.value).toBe('')
  })

  it('does not call the api when there is no cookie', async () => {
    const response = await endSession(post('/auth/logout'))
    expect(response.status).toBe(204)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a request from another site', async () => {
    const response = await endSession(
      post('/auth/logout', { cookie: 'c', origin: 'https://evil.example.com' })
    )
    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the cookie in production', () => {
  it('is deleted with Secure and the __Host- name, or the browser ignores the deletion', async () => {
    jest.resetModules()
    jest.doMock('../../lib/env', () => ({
      isProduction: true,
      webEnv: { NEXT_PUBLIC_API_URL: 'https://api.example.com' }
    }))
    const { refreshSession: refreshInProduction } = await import('./session-handlers')
    fetchMock.mockResolvedValue(
      json(401, {
        error: { code: 'AUTH_TOKEN_INVALID', message: 'x', metadata: {} },
        correlationId: 'c'
      })
    )
    const request = new NextRequest(`https://${HOST}/auth/refresh`, {
      method: 'POST',
      headers: { host: HOST, origin: `https://${HOST}`, cookie: '__Host-platform_refresh=old' }
    })
    const response = await refreshInProduction(request)
    const cleared = response.cookies.get('__Host-platform_refresh')
    expect(cleared).toMatchObject({ value: '', secure: true, path: '/' })
    expect(response.headers.get('set-cookie')).toContain('Secure')
    jest.dontMock('../../lib/env')
  })
})
