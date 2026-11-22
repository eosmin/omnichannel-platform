import { TenantHeaders } from '@platform/core/auth'
import { COOKIE_POLICY_VERSION } from '@platform/core/cookie-consent'

import { createApiClient } from './api-client'
import { recordCookieConsent } from './compliance-api'

const CHOICE = {
  visitorId: '3f2b8c1e-0a4d-4f6e-9b1a-7c5d2e8f9a10',
  categories: { functional: true, analytics: false, marketing: false }
}

function setup(body: unknown) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
  )
  const getAccessToken = jest.fn(() => 'token')
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken,
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

describe('the answer of the cookie banner', () => {
  it('goes to the public route with the policy version it was shown, and with no token and no store', async () => {
    const { client, fetchImpl } = setup({ recorded: true })
    await expect(recordCookieConsent(client, CHOICE)).resolves.toEqual({ recorded: true })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    const headers = init?.headers as Record<string, string>
    expect(url).toBe('https://api.example.com/api/v1/compliance/cookie-consent')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      ...CHOICE,
      policyVersion: COOKIE_POLICY_VERSION
    })
    expect(headers[TenantHeaders.STORE_ID]).toBeUndefined()
    expect(headers.Authorization ?? headers.authorization).toBeUndefined()
  })

  it('refuses an answer that is not a result', async () => {
    const { client } = setup({ ok: true })
    await expect(recordCookieConsent(client, CHOICE)).rejects.toThrow()
  })
})
