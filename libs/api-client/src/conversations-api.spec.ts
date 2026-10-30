import { ConversationStatus } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  fetchChannelDirectory,
  fetchConversationCounts,
  fetchConversationOrigins,
  fetchConversationsPage,
  markConversationRead
} from './conversations-api'

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

const item = {
  id: 'c1',
  status: 'OPEN',
  channelType: 'whatsapp',
  assignedTo: null,
  unreadCount: 2,
  lastMessageAt: '2026-10-30T10:00:00.000Z',
  snoozedUntil: null,
  customer: { id: 'u1', name: null, displayIdentity: '5037123', username: null, avatarUrl: null },
  lastMessage: null,
  tags: []
}

describe('fetchConversationsPage', () => {
  it('asks for the filters and the cursor, and for nothing that is not named', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [item], nextCursor: 'n', hasMore: true }))

    const page = await fetchConversationsPage(
      client,
      's1',
      { assigned: 'me', status: ConversationStatus.OPEN, channelType: 'whatsapp' },
      'abc'
    )

    expect(page.data).toHaveLength(1)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(
      'https://api.example.com/api/v1/conversations?assigned=me&status=OPEN&channelType=whatsapp&cursor=abc'
    )
    expect(init?.headers).toMatchObject({ 'x-store-id': 's1' })
  })

  it('has no query string without filters', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchConversationsPage(client, 's1', {}, null)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/conversations')
  })

  it('keeps a status it does not know instead of failing the page', async () => {
    const { client } = setup(
      json(200, { data: [{ ...item, status: 'FUTURE' }], nextCursor: null, hasMore: false })
    )

    const page = await fetchConversationsPage(client, 's1', {}, null)

    expect(page.data[0]?.status).toBe('FUTURE')
  })
})

describe('fetchConversationCounts', () => {
  it('asks for the counts alone', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        all: 3,
        mine: 1,
        unassigned: 2,
        byStatus: { OPEN: 3 },
        byChannel: {},
        byAgent: []
      })
    )

    const counts = await fetchConversationCounts(client, 's1')

    expect(counts.byStatus).toEqual({ OPEN: 3 })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/conversations?countsOnly=true'
    )
  })
})

describe('fetchChannelDirectory', () => {
  it('reads the channels of the store', async () => {
    const { client, fetchImpl } = setup(
      json(200, [
        {
          id: 'k1',
          pluginId: 'whatsapp',
          pluginName: 'WhatsApp',
          displayName: 'Shop',
          status: 'active',
          capabilities: ['TEXT']
        }
      ])
    )

    const channels = await fetchChannelDirectory(client, 's1')

    expect(channels[0]?.displayName).toBe('Shop')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/channels/directory')
  })
})

describe('fetchConversationOrigins', () => {
  it('reads the origins of the conversation, newest first', async () => {
    const origin = {
      id: 'o1',
      messageId: 'm1',
      kind: 'ad',
      sourceId: null,
      sourceUrl: 'https://example.com/ad',
      title: 'Spring sale',
      body: null,
      mediaType: null,
      mediaUrl: null,
      thumbnailUrl: null,
      createdAt: '2026-10-30T10:00:00.000Z'
    }
    const { client, fetchImpl } = setup(json(200, [origin]))

    expect(await fetchConversationOrigins(client, 's1', 'c1')).toEqual([origin])

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/conversations/c1/origins'
    )
  })
})

describe('markConversationRead', () => {
  it('posts to the read route of the conversation for the store', async () => {
    const { client, fetchImpl } = setup(json(200, { id: 'c1' }))

    await markConversationRead(client, 's1', 'c1')

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/conversations/c1/read')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'x-store-id': 's1' })
  })
})
