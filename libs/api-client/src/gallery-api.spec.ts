import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import { requestMediaZip } from './exports-api'
import { fetchCustomerMedia, galleryPageSchema } from './gallery-api'

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

const item = {
  id: 'm1',
  type: 'image',
  filename: 'a.jpg',
  contentType: 'image/jpeg',
  fileSizeBytes: 10,
  createdAt: '2026-11-01T10:00:00.000Z',
  channelType: 'whatsapp'
}
const counts = { all: 1, image: 1, video: 0, audio: 0, document: 0 }

describe('fetchCustomerMedia', () => {
  it('asks the gallery of the customer in the store of the request, with the tab, search and cursor', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [item], nextCursor: null, hasMore: false, counts })
    )
    const page = await fetchCustomerMedia(
      client,
      's1',
      'c1',
      { type: 'image', q: ' zapato ' },
      'cur'
    )
    expect(page.counts?.image).toBe(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/api/v1/customers/c1/media')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      type: 'image',
      q: 'zapato',
      cursor: 'cur'
    })
    expect((init.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBe('s1')
  })

  it('sends no type for "all" and no search when it is blank', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [], nextCursor: null, hasMore: false, counts: null })
    )
    await fetchCustomerMedia(client, 's1', 'c1', { type: 'all', q: '  ' }, null)
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/media'
    )
  })
})

describe('galleryPageSchema', () => {
  it('lists a file of a type it does not know without a tab instead of failing', () => {
    const page = galleryPageSchema.parse({
      data: [{ ...item, type: 'hologram' }],
      nextCursor: null,
      hasMore: false,
      counts: null
    })
    expect(page.data[0]?.type).toBeNull()
  })
})

describe('requestMediaZip', () => {
  const row = {
    id: 'e1',
    type: 'media_zip',
    format: 'zip',
    status: 'pending',
    filename: null,
    rowCount: null,
    error: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    completedAt: null,
    expiresAt: '2026-11-08T10:00:00.000Z'
  }

  it('posts the customer and only the filters that are set', async () => {
    const { client, fetchImpl } = setup(json(202, row))
    const result = await requestMediaZip(client, 's1', { customerId: 'c1', type: 'all', q: '' })
    expect(result.id).toBe('e1')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/api/v1/media/download-all')
    expect(JSON.parse(init.body as string)).toEqual({ customerId: 'c1' })
  })

  it('adds the tab and the search of the gallery', async () => {
    const { client, fetchImpl } = setup(json(202, row))
    await requestMediaZip(client, 's1', { customerId: 'c1', type: 'video', q: ' demo ' })
    expect(
      JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    ).toEqual({ customerId: 'c1', type: 'video', q: 'demo' })
  })
})
