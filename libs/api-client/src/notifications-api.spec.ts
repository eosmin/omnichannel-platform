import { TenantHeaders } from '@platform/core/auth'
import { NotificationFilters } from '@platform/core/notifications'

import { createApiClient } from './api-client'
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationsRead
} from './notifications-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(response: Response) {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(response.clone()))
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const row = {
  id: 'n1',
  type: 'export.ready',
  severity: 'success',
  messageKey: 'notifications.export.ready',
  params: { filename: 'a.csv' },
  resourceType: 'export',
  resourceId: 'e1',
  actionPath: '/s/store-1/exports',
  readAt: null,
  createdAt: '2026-11-02T10:00:00.000Z'
}

describe('fetchNotifications', () => {
  it('asks the tab in the store of the request, with the cursor when there is one', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [row], nextCursor: 'c2', hasMore: true }))
    const page = await fetchNotifications(client, 'store-1', {
      filter: NotificationFilters.UNREAD,
      cursor: 'c1'
    })
    expect(page.data[0]?.id).toBe('n1')
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/notifications?filter=unread&cursor=c1')
    expect(new Headers(init?.headers).get(TenantHeaders.STORE_ID)).toBe('store-1')
  })

  it('keeps a type it does not know instead of failing', async () => {
    const { client } = setup(
      json(200, {
        data: [{ ...row, type: 'future.thing', severity: 'loud' }],
        nextCursor: null,
        hasMore: false
      })
    )
    const page = await fetchNotifications(client, 'store-1', {
      filter: NotificationFilters.ALL,
      cursor: null
    })
    expect(page.data[0]?.type).toBe('future.thing')
  })
})

describe('the counters and the marks', () => {
  it('reads the unread count', async () => {
    const { client } = setup(json(200, { count: 7 }))
    await expect(fetchUnreadCount(client, 'store-1')).resolves.toBe(7)
  })

  it('posts the ids to mark and answers how many changed', async () => {
    const { client, fetchImpl } = setup(json(200, { updated: 2 }))
    await expect(markNotificationsRead(client, 'store-1', ['n1', 'n2'])).resolves.toBe(2)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/notifications/read')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      ids: ['n1', 'n2']
    })
  })

  it('marks everything as read', async () => {
    const { client, fetchImpl } = setup(json(200, { updated: 5 }))
    await expect(markAllNotificationsRead(client, 'store-1')).resolves.toBe(5)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/notifications/read-all'
    )
  })
})
