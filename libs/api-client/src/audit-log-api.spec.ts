import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import { ApiError } from './api-error'
import { fetchAuditLog, fetchAuditLogEntry, requestAuditLogExport } from './audit-log-api'

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

const entry = {
  id: '0b0d6b1e-5a7e-4a52-9d65-0a6f3f0e9c11',
  action: 'order.created',
  userId: null,
  resourceType: 'order',
  resourceId: 'o1',
  metadata: { items: 2 },
  ipAddress: null,
  userAgent: null,
  timestamp: '2026-11-01T10:00:00.000Z'
}
const page = { data: [entry], nextCursor: 'c2', hasMore: true }
const urlOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>): string =>
  fetchImpl.mock.calls[0]?.[0] ?? ''

describe('fetchAuditLog', () => {
  it('asks the log in the store of the request, with no query when nothing narrows it', async () => {
    const { client, fetchImpl } = setup(json(200, page))
    const result = await fetchAuditLog(client, 'store-1', {}, null)
    expect(result.data[0]?.action).toBe('order.created')
    expect(result.nextCursor).toBe('c2')
    expect(urlOf(fetchImpl)).toBe('https://api.example.com/api/v1/organizations/current/audit-log')
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get(TenantHeaders.STORE_ID)).toBe('store-1')
  })

  it('sends the filters and the cursor, and never a store of its own', async () => {
    const { client, fetchImpl } = setup(json(200, page))
    await fetchAuditLog(
      client,
      'store-1',
      {
        action: 'order.created',
        userId: 'u1',
        from: '2026-11-01T00:00:00.000Z',
        before: '2026-11-02T00:00:00.000Z'
      },
      'c1'
    )
    const query = new URL(urlOf(fetchImpl)).searchParams
    expect(Object.fromEntries(query)).toEqual({
      action: 'order.created',
      userId: 'u1',
      from: '2026-11-01T00:00:00.000Z',
      before: '2026-11-02T00:00:00.000Z',
      cursor: 'c1'
    })
    expect(query.has('storeId')).toBe(false)
  })

  it('keeps a metadata of any shape, a null one included', async () => {
    const { client } = setup(
      json(200, { data: [{ ...entry, metadata: null }], nextCursor: null, hasMore: false })
    )
    expect((await fetchAuditLog(client, 's', {}, null)).data[0]?.metadata).toBeNull()
  })
})

describe('fetchAuditLogEntry', () => {
  it('reads one entry by its id, in the store of the request', async () => {
    const { client, fetchImpl } = setup(json(200, entry))
    expect((await fetchAuditLogEntry(client, 'store-1', entry.id)).id).toBe(entry.id)
    expect(urlOf(fetchImpl)).toBe(
      `https://api.example.com/api/v1/organizations/current/audit-log/${entry.id}`
    )
  })
})

describe('requestAuditLogExport', () => {
  const row = {
    id: 'e1',
    type: 'audit_log',
    format: 'csv',
    status: 'pending',
    filename: null,
    rowCount: null,
    progress: null,
    error: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    completedAt: null,
    expiresAt: '2026-11-08T10:00:00.000Z'
  }

  it('queues the file for the same filters as the screen, with no cursor', async () => {
    const { client, fetchImpl } = setup(json(202, row))
    const exported = await requestAuditLogExport(client, 'store-1', { action: 'order.created' })
    expect(exported.type).toBe('audit_log')
    expect(urlOf(fetchImpl)).toBe(
      'https://api.example.com/api/v1/organizations/current/audit-log/export?action=order.created'
    )
  })

  it('passes the refusal of a range that is too large on, with its code', async () => {
    const { client } = setup(
      json(400, {
        error: { code: 'EXPORT_TOO_LARGE', message: 'too large', metadata: {} },
        correlationId: 'c-1'
      })
    )
    const failure: unknown = await requestAuditLogExport(client, 'store-1', {}).catch(
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as ApiError).code).toBe('EXPORT_TOO_LARGE')
  })
})
