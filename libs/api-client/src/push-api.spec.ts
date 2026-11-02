import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import { registerPushSubscription, removePushSubscription } from './push-api'

function setup() {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })))
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

describe('registerPushSubscription', () => {
  it('posts the browser to the route of the member, in the store of the request', async () => {
    const { client, fetchImpl } = setup()
    const registration = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: 'key',
      auth: 'secret',
      userAgent: 'Firefox'
    }
    await expect(registerPushSubscription(client, 'store-1', registration)).resolves.toBeUndefined()
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/notifications/push-subscription')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBe('store-1')
    expect(JSON.parse(init?.body as string)).toEqual(registration)
  })
})

describe('removePushSubscription', () => {
  it('posts only the endpoint, to the route that removes', async () => {
    const { client, fetchImpl } = setup()
    await expect(
      removePushSubscription(client, 'store-1', 'https://fcm.googleapis.com/fcm/send/abc')
    ).resolves.toBeUndefined()
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/notifications/push-subscription/remove')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc'
    })
  })
})
