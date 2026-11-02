import { ApiError, createApiClient } from '@platform/api-client'
import { TenantHeaders } from '@platform/core/auth'

import { fetchBusinessHours, saveBusinessHours } from './hours-requests'

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          })
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  const call = () => fetchImpl.mock.calls[0] ?? []
  return { client, call }
}

const hours = {
  timezone: 'America/Mexico_City',
  schedule: {
    mon: [{ from: '09:00', to: '18:00' }],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: []
  },
  awayMessageSnippetId: null
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

describe('business hours requests', () => {
  it('reads the schedule of the store named in X-Store-Id', async () => {
    const { client, call } = setup(hours)
    await expect(fetchBusinessHours(client, 's1')).resolves.toEqual(hours)
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/business-hours')
    expect(header(call()[1], TenantHeaders.STORE_ID)).toBe('s1')
  })

  it('lets the page tell a store with no schedule from one that is closed', async () => {
    const { client } = setup(
      { error: { code: 'RESOURCE_NOT_FOUND', message: 'x' }, correlationId: 'c1' },
      404
    )
    await expect(fetchBusinessHours(client, 's1')).rejects.toMatchObject({
      status: 404,
      code: 'RESOURCE_NOT_FOUND'
    })
    await expect(fetchBusinessHours(client, 's1')).rejects.toBeInstanceOf(ApiError)
  })

  it('replaces the whole week with a PUT', async () => {
    const { client, call } = setup(hours)
    await saveBusinessHours(client, 's1', hours)
    expect(call()[1]?.method).toBe('PUT')
    expect(bodyOf(call()[1])).toEqual(hours)
  })
})
