import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import {
  createOrganizationStore,
  deleteOrganizationStore,
  fetchOrganization,
  fetchOrganizationStore,
  renameOrganization,
  updateOrganizationStore
} from './organizations-api'

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
  return { client, fetchImpl }
}

const STORE = {
  id: 's2',
  name: 'Shop',
  slug: 'shop',
  timezone: 'America/El_Salvador',
  currency: 'USD',
  defaultLocale: 'es'
}

function storeHeaderOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[TenantHeaders.STORE_ID]
}

describe('the organization', () => {
  it('is read and renamed through the store of the request', async () => {
    const { client, fetchImpl } = setup({ id: 'o1', name: 'Acme', slug: 'acme' })
    await expect(fetchOrganization(client, 's1')).resolves.toEqual({
      id: 'o1',
      name: 'Acme',
      slug: 'acme'
    })
    await renameOrganization(client, 's1', 'Acme 2')
    const [, readInit] = fetchImpl.mock.calls[0] ?? []
    const [url, patchInit] = fetchImpl.mock.calls[1] ?? []
    expect(url).toBe('https://api.example.com/api/v1/organizations/current')
    expect(storeHeaderOf(readInit)).toBe('s1')
    expect(patchInit?.method).toBe('PATCH')
    expect(JSON.parse(patchInit?.body as string)).toEqual({ name: 'Acme 2' })
  })
})

describe('the stores of the organization', () => {
  it('reads, creates and changes a store, naming it in the path and the request store in the header', async () => {
    const { client, fetchImpl } = setup(STORE)
    await fetchOrganizationStore(client, 's1', 's2')
    await createOrganizationStore(client, 's1', { name: 'Shop', currency: 'USD' })
    await updateOrganizationStore(client, 's1', 's2', { name: 'Shop 2' })
    const calls = fetchImpl.mock.calls
    expect(calls[0]?.[0]).toBe('https://api.example.com/api/v1/organizations/current/stores/s2')
    expect(calls[1]?.[0]).toBe('https://api.example.com/api/v1/organizations/current/stores')
    expect(calls[1]?.[1]?.method).toBe('POST')
    expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({ name: 'Shop', currency: 'USD' })
    expect(calls[2]?.[1]?.method).toBe('PATCH')
    expect(JSON.parse(calls[2]?.[1]?.body as string)).toEqual({ name: 'Shop 2' })
    for (const call of calls) expect(storeHeaderOf(call[1])).toBe('s1')
  })

  it('deletes by id and answers nothing', async () => {
    const { client, fetchImpl } = setup(null, 204)
    await expect(deleteOrganizationStore(client, 's1', 's2')).resolves.toBeUndefined()
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/organizations/current/stores/s2')
    expect(init?.method).toBe('DELETE')
  })
})
