import { MessageType } from '@platform/core/domain'

import { createApiClient } from './api-client'
import { sendMessage } from './messages-api'
import { fetchTeamPresence } from './presence-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(response: Response) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockResolvedValue(response)
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

describe('sendMessage', () => {
  it('posts the message with its idempotency key to the store and reads the answer', async () => {
    const { client, fetchImpl } = setup(
      json(201, { id: 'm1', conversationId: 'c1', deliveryStatus: 'QUEUED', extra: true })
    )
    const sent = await sendMessage(client, 's1', {
      type: MessageType.TEXT,
      conversationId: 'c1',
      content: 'hola',
      idempotencyKey: 'key-1'
    })
    expect(sent).toEqual({ id: 'm1', conversationId: 'c1', deliveryStatus: 'QUEUED' })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/messages')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'x-store-id': 's1' })
    expect(JSON.parse(init?.body as string)).toEqual({
      type: 'TEXT',
      conversationId: 'c1',
      content: 'hola',
      idempotencyKey: 'key-1'
    })
  })

  it('takes the 200 of a retry as the message that already existed', async () => {
    const { client } = setup(json(200, { id: 'm1', conversationId: 'c1', deliveryStatus: null }))
    await expect(
      sendMessage(client, 's1', {
        type: MessageType.TEXT,
        conversationId: 'c1',
        content: 'hola',
        idempotencyKey: 'key-1'
      })
    ).resolves.toMatchObject({ id: 'm1' })
  })
})

describe('fetchTeamPresence', () => {
  it('reads the presence of the team of the store', async () => {
    const { client, fetchImpl } = setup(json(200, [{ userId: 'u1', status: 'online' }]))
    await expect(fetchTeamPresence(client, 's1')).resolves.toEqual([
      { userId: 'u1', status: 'online' }
    ])
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/presence')
    expect(fetchImpl.mock.calls[0]?.[1].headers).toMatchObject({ 'x-store-id': 's1' })
  })
})
