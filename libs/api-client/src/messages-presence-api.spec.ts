import { MessageType } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  deleteMessage,
  editMessage,
  fetchDeletedContent,
  fetchMessagesPage,
  fetchRevisions,
  reactToMessage,
  resendMessage,
  sendMessage
} from './messages-api'
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

const message = {
  id: 'm1',
  conversationId: 'c1',
  type: 'TEXT',
  content: 'hola',
  authorType: 'customer',
  authorId: null,
  replyToMessageId: null,
  replyTo: null,
  deliveryStatus: null,
  deliveryError: null,
  system: null,
  attachmentUrl: null,
  reactions: [],
  media: [],
  mentions: [],
  version: 1,
  editedAt: null,
  editedByType: null,
  editedById: null,
  pendingEdit: false,
  editStatus: null,
  editError: null,
  deletedAt: null,
  deletedByType: null,
  deletedById: null,
  deleteStatus: null,
  deleteError: null,
  createdAt: '2026-10-30T10:00:00.000Z'
}

describe('fetchMessagesPage', () => {
  it('reads a page of the thread and asks for the next one by its cursor', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [{ ...message, extra: true }], nextCursor: 'n', hasMore: true })
    )

    const page = await fetchMessagesPage(client, 's1', 'c1', 'abc')

    expect(page.data).toEqual([message])
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/conversations/c1/messages?cursor=abc')
    expect(init?.headers).toMatchObject({ 'x-store-id': 's1' })
  })

  it('has no query string for the first page', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchMessagesPage(client, 's1', 'c1', null)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/conversations/c1/messages'
    )
  })
})

describe('the actions on a message', () => {
  const noContent = (): Response => new Response(null, { status: 204 })

  it('puts the emoji, and null takes the reaction back, both answered with 204', async () => {
    const { client, fetchImpl } = setup(noContent())
    await reactToMessage(client, 's1', 'm1', '👍')
    await reactToMessage(client, 's1', 'm1', null)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/messages/m1/reaction')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ emoji: '👍' })
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toEqual({ emoji: null })
  })

  it('patches the whole new text with the version of a note, and nothing else', async () => {
    const { client, fetchImpl } = setup(json(200, message))
    await editMessage(client, 's1', 'm1', { content: 'new', version: 3 })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/messages/m1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ content: 'new', version: 3 })
  })

  it('deletes with the store header and posts to resend', async () => {
    const removal = setup(noContent())
    await deleteMessage(removal.client, 's1', 'm1')
    expect(removal.fetchImpl.mock.calls[0]?.[1]?.method).toBe('DELETE')
    expect(removal.fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-store-id': 's1' })

    const again = setup(json(200, message))
    await resendMessage(again.client, 's1', 'm1')
    expect(again.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/messages/m1/resend'
    )
    expect(again.fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST')
  })

  it('reads the kept text and the revisions', async () => {
    const kept = setup(json(200, { content: 'gone' }))
    expect(await fetchDeletedContent(kept.client, 's1', 'm1')).toEqual({ content: 'gone' })
    expect(kept.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/messages/m1/deleted-content'
    )

    const history = setup(
      json(200, [
        {
          version: 1,
          content: 'old',
          editedByType: 'agent',
          editedById: 'u1',
          createdAt: '2026-10-30T10:00:00.000Z',
          extra: true
        }
      ])
    )
    const revisions = await fetchRevisions(history.client, 's1', 'm1')
    expect(revisions).toEqual([
      {
        version: 1,
        content: 'old',
        editedByType: 'agent',
        editedById: 'u1',
        createdAt: '2026-10-30T10:00:00.000Z'
      }
    ])
  })
})
