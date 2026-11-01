import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import { fetchExportDownload, fetchExports } from './exports-api'

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
  id: 'e1',
  type: 'media_zip',
  format: 'zip',
  status: 'ready',
  filename: 'files.zip',
  rowCount: 3,
  error: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  completedAt: '2026-11-01T10:01:00.000Z',
  expiresAt: '2026-11-08T10:01:00.000Z'
}

describe('fetchExports', () => {
  it('asks the list in the store of the request, with the cursor when there is one', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [row], nextCursor: 'c2', hasMore: true }))
    const page = await fetchExports(client, 'store-1', 'c1')
    expect(page.data[0]?.id).toBe('e1')
    expect(page.nextCursor).toBe('c2')
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/exports?cursor=c1')
    expect(new Headers(init?.headers).get(TenantHeaders.STORE_ID)).toBe('store-1')
  })

  it('asks the first page with no query, and keeps a kind or state it does not know', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        data: [{ ...row, type: 'invoices', status: 'paused' }],
        nextCursor: null,
        hasMore: false
      })
    )
    const page = await fetchExports(client, 'store-1', null)
    expect(page.data[0]?.type).toBe('invoices')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/exports')
  })
})

describe('fetchExportDownload', () => {
  it('asks the signed link of one export', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        url: 'https://files.example.com/x',
        filename: 'files.zip',
        expiresInSeconds: 300
      })
    )
    const link = await fetchExportDownload(client, 'store-1', 'e1')
    expect(link.url).toBe('https://files.example.com/x')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/exports/e1/download')
  })
})
