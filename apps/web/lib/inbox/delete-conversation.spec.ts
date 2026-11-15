import { createApiClient } from '@platform/api-client'

import { deleteConversation } from './delete-conversation'

describe('deleteConversation', () => {
  it('sends DELETE to the conversation of the store, with no body, and accepts the 204', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      getAccessToken: () => 'token',
      refreshAccessToken: () => Promise.resolve('token'),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    await expect(deleteConversation(client, 's1', 'c/1')).resolves.toBeUndefined()
    const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
    expect(url).toBe('https://api.example.com/api/v1/conversations/c%2F1')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get('x-store-id')).toBe('s1')
  })
})
