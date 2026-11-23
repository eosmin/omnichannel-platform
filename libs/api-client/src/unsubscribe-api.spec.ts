import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import { unsubscribeFromNotificationEmails } from './unsubscribe-api'

describe('the one-click unsubscribe call', () => {
  it('POSTs the token in the body to the public route, with no token of a session and no store', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    const getAccessToken = jest.fn(() => 'session-token')
    const refresh = jest.fn(() => Promise.resolve('session-token'))
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      getAccessToken,
      refreshAccessToken: refresh,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    await expect(
      unsubscribeFromNotificationEmails(client, 'v1.ne.abc.mac')
    ).resolves.toBeUndefined()

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    const headers = init?.headers as Record<string, string>
    expect(url).toBe('https://api.example.com/api/v1/notifications/unsubscribe')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ token: 'v1.ne.abc.mac' })
    expect(headers['Authorization']).toBeUndefined()
    expect(headers[TenantHeaders.STORE_ID]).toBeUndefined()
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})
