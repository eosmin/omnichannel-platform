import { createApiClient } from '@platform/api-client'
import { TenantHeaders } from '@platform/core/auth'

import { catalogEntrySchema } from './channels-requests'
import { deletePlugin, rotatePluginApiKey } from './plugins-requests'

function setup(status: number) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(
            JSON.stringify({
              error: { code: 'PLUGIN_IN_USE', message: 'in use' },
              correlationId: 'c1'
            }),
            {
              status,
              headers: { 'content-type': 'application/json' }
            }
          )
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, call: () => fetchImpl.mock.calls[0] ?? [] }
}

describe('deleting a plugin', () => {
  it('sends the name that was typed to the plugin of the store in the header, and answers nothing', async () => {
    const { client, call } = setup(204)

    await expect(deletePlugin(client, 's1', 'acme-sync', 'Acme Sync')).resolves.toBeUndefined()

    expect(call()[0]).toBe('https://api.example.com/api/v1/plugins/acme-sync')
    expect(call()[1]?.method).toBe('DELETE')
    expect(JSON.parse(call()[1]?.body as string)).toEqual({ confirmation: 'Acme Sync' })
    expect(new Headers(call()[1]?.headers).get(TenantHeaders.STORE_ID)).toBe('s1')
  })

  it('writes the id of the plugin as a path segment', async () => {
    const { client, call } = setup(204)

    await deletePlugin(client, 's1', 'a/b?c', 'x')

    expect(call()[0]).toBe('https://api.example.com/api/v1/plugins/a%2Fb%3Fc')
  })

  it('lets the refusal of the api through, with its code', async () => {
    const { client } = setup(409)

    await expect(deletePlugin(client, 's1', 'acme-sync', 'Acme Sync')).rejects.toMatchObject({
      code: 'PLUGIN_IN_USE'
    })
  })
})

describe('the catalog entry of a plugin', () => {
  const entry = {
    id: 'acme',
    name: 'Acme',
    authorName: 'Acme Inc',
    type: 'integration',
    isOfficial: false,
    installed: false,
    installationId: null,
    activeConnections: 0,
    channel: null
  }

  it('is deletable only when the api says the organization registered it', () => {
    expect(catalogEntrySchema.parse({ ...entry, registered: true }).registered).toBe(true)
    expect(catalogEntrySchema.parse({ ...entry, registered: false }).registered).toBe(false)
    // A server that does not say, or says something else, offers no delete
    expect(catalogEntrySchema.parse(entry).registered).toBe(false)
    expect(catalogEntrySchema.parse({ ...entry, registered: 'yes' }).registered).toBe(false)
  })
})

describe('rotating the key of a plugin installation', () => {
  function rotateSetup(body: unknown, status = 200) {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
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
    return { client, call: () => fetchImpl.mock.calls[0] ?? [] }
  }

  it('posts to the installation of the store, with its id as a path segment, and reads the key', async () => {
    const { client, call } = rotateSetup({
      apiKey: 'plg_live_abc',
      apiKeyPrefix: 'plg_live_ab',
      rotatedAt: '2026-11-21T10:00:00.000Z'
    })

    await expect(rotatePluginApiKey(client, 's1', 'i/1?x')).resolves.toEqual({
      apiKey: 'plg_live_abc',
      apiKeyPrefix: 'plg_live_ab',
      rotatedAt: '2026-11-21T10:00:00.000Z'
    })

    expect(call()[0]).toBe('https://api.example.com/api/v1/plugins/i%2F1%3Fx/api-key')
    expect(call()[1]?.method).toBe('POST')
    expect(new Headers(call()[1]?.headers).get(TenantHeaders.STORE_ID)).toBe('s1')
  })

  it('refuses an answer that has no key', async () => {
    const { client } = rotateSetup({ apiKeyPrefix: 'plg_live_ab', rotatedAt: 'x' })

    await expect(rotatePluginApiKey(client, 's1', 'i1')).rejects.toBeDefined()
  })

  it('says the error of the api when the installation is not found', async () => {
    const { client } = rotateSetup(
      { error: { code: 'RESOURCE_NOT_FOUND', message: 'nope' }, correlationId: 'c1' },
      404
    )

    await expect(rotatePluginApiKey(client, 's1', 'i1')).rejects.toMatchObject({ status: 404 })
  })
})
