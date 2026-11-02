import { TenantHeaders } from '@platform/core/auth'

import {
  fetchAccountPreferences,
  fetchActiveSessions,
  fetchOwnProfile,
  revokeSession,
  updateAccountPreferences,
  updateOwnProfile
} from './account-api'
import { createApiClient } from './api-client'

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

const PROFILE = { id: 'u1', email: 'a@b.c', name: 'Ana', avatarMediaId: null, avatarUrl: null }

describe('the profile of the person', () => {
  it('is read and changed on its own route, with no store', async () => {
    const { client, fetchImpl } = setup(PROFILE)
    await expect(fetchOwnProfile(client)).resolves.toEqual(PROFILE)
    await updateOwnProfile(client, { name: 'Ana M' })
    const [readUrl, readInit] = fetchImpl.mock.calls[0] ?? []
    const [patchUrl, patchInit] = fetchImpl.mock.calls[1] ?? []
    expect(readUrl).toBe('https://api.example.com/api/v1/account/profile')
    expect(patchUrl).toBe('https://api.example.com/api/v1/account/profile')
    expect(patchInit?.method).toBe('PATCH')
    expect(JSON.parse(patchInit?.body as string)).toEqual({ name: 'Ana M' })
    expect((readInit?.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBeUndefined()
    expect((patchInit?.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBeUndefined()
  })

  it('refuses an answer that is not a profile', async () => {
    const { client } = setup({ id: 'u1' })
    await expect(fetchOwnProfile(client)).rejects.toThrow()
  })
})

describe('the preferences of the person', () => {
  it('are patched with only the fields that change, null included', async () => {
    const { client, fetchImpl } = setup({ locale: 'es', timezone: null, density: 'compact' })
    await expect(fetchAccountPreferences(client)).resolves.toEqual({
      locale: 'es',
      timezone: null,
      density: 'compact'
    })
    await updateAccountPreferences(client, { timezone: null })
    const [url, init] = fetchImpl.mock.calls[1] ?? []
    expect(url).toBe('https://api.example.com/api/v1/account/preferences')
    expect(JSON.parse(init?.body as string)).toEqual({ timezone: null })
  })
})

describe('the sessions of the person', () => {
  it('lists the devices and revokes one by the id of its family', async () => {
    const sessions = [
      {
        id: 'f1',
        userAgent: 'Firefox',
        ipAddress: '1.2.3.4',
        lastActiveAt: '2026-11-02T10:00:00.000Z',
        current: true
      }
    ]
    const list = setup(sessions)
    await expect(fetchActiveSessions(list.client)).resolves.toEqual(sessions)
    expect(list.fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/auth/sessions')

    const revoke = setup(null, 204)
    await expect(revokeSession(revoke.client, 'a/b')).resolves.toBeUndefined()
    const [url, init] = revoke.fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/auth/sessions/a%2Fb')
    expect(init?.method).toBe('DELETE')
  })
})
