import { ApiError, createApiClient } from '@platform/api-client'
import { TenantHeaders } from '@platform/core/auth'

import {
  connectChannel,
  disconnectConnection,
  renameConnection,
  updateConnectionToken,
  fetchConnections,
  fetchPluginCatalog,
  cancelOAuth,
  completeOAuth,
  fetchOAuthAssets,
  fetchWidget,
  installPlugin,
  saveWidgetOrigins,
  saveWidgetPreChat,
  startOAuthLogin,
  testConnection,
  uninstallPlugin
} from './channels-requests'

function setup(body: unknown, status = 200) {
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
  const call = () => fetchImpl.mock.calls[0] ?? []
  return { client, call }
}

// The JSON the client sent
const bodyOf = (init: unknown): unknown => {
  const body = (init as RequestInit | undefined)?.body
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined
}

const connection = {
  id: 'c1',
  pluginId: 'whatsapp',
  displayName: '+57 300 0000000',
  label: null,
  accountName: '+57 300 0000000',
  status: 'active',
  lastHealthyAt: '2026-11-02T10:00:00.000Z',
  lastError: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  capabilities: ['text', 'templates'],
  profile: null,
  tokenExpiry: { state: 'unknown', expiresAt: null, checkedAt: null, kind: 'unknown' }
}
const widget = {
  siteKey: 'pk_widget_x',
  allowedOrigins: ['https://a.com'],
  preChatEnabled: false,
  snippet: '<script></script>',
  connectSrc: ['https://api.example.com'],
  scriptSrc: ['https://cdn.example.com']
}
const entry = {
  id: 'whatsapp',
  name: 'WhatsApp',
  authorName: 'Platform Team',
  type: 'channel',
  isOfficial: true,
  installed: true,
  installationId: 'i1',
  activeConnections: 1,
  channel: {
    connectFields: [
      { key: 'accessToken', labelKey: 'k', secret: true, required: true, multiple: false }
    ],
    callbackUrl: 'https://api.example.com/api/v1/webhooks/channels/whatsapp'
  }
}

describe('the channel requests', () => {
  it('reads the connections of the store named in the header', async () => {
    const page = { data: [connection], nextCursor: null, hasMore: false }
    const { client, call } = setup(page)
    await expect(fetchConnections(client, 's1', 'live', null)).resolves.toEqual(page)
    const [url, init] = call()
    expect(url).toBe('https://api.example.com/api/v1/channels/connections?state=live')
    expect((init?.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBe('s1')
  })

  it('keeps what the platform learned of the token, and takes a server that says nothing for not knowing', async () => {
    const known = {
      state: 'expires',
      expiresAt: '2026-12-01T00:00:00.000Z',
      checkedAt: '2026-11-07T00:00:00.000Z',
      kind: 'page'
    }
    const withoutIt: Record<string, unknown> = { ...connection }
    delete withoutIt['tokenExpiry']
    const { client } = setup({
      data: [
        { ...connection, tokenExpiry: known },
        withoutIt,
        { ...connection, tokenExpiry: 'soon' }
      ],
      nextCursor: null,
      hasMore: false
    })

    const read = await fetchConnections(client, 's1', 'live', null)

    expect(read.data[0]?.tokenExpiry).toEqual(known)
    // An older server, or an answer that does not fit: nothing is said of the token, and never that it expired
    expect(read.data[1]?.tokenExpiry).toEqual(connection.tokenExpiry)
    expect(read.data[2]?.tokenExpiry).toEqual(connection.tokenExpiry)
  })

  it('keeps a status and a capability it does not know as the text it came as', async () => {
    const { client } = setup({
      data: [{ ...connection, status: 'paused', capabilities: ['hologram'] }],
      nextCursor: null,
      hasMore: false
    })
    const {
      data: [read]
    } = await fetchConnections(client, 's1', 'live', null)
    expect(read?.status).toBe('paused')
    expect(read?.capabilities).toEqual(['hologram'])
  })

  it('sends the credentials in the body and never in the url', async () => {
    const { client, call } = setup(connection, 201)
    await connectChannel(client, 's1', 'whatsapp', { accessToken: 'secret-token' })
    const [url, init] = call()
    expect(url).toBe('https://api.example.com/api/v1/channels/whatsapp/connect')
    expect(String(url)).not.toContain('secret-token')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      credentials: { accessToken: 'secret-token' }
    })
  })

  it('encodes the ids it puts in a path', async () => {
    const { client, call } = setup({ healthy: true, checkedAt: '2026-11-02T10:00:00.000Z' })
    await testConnection(client, 's1', 'a/b')
    expect(call()[0]).toBe('https://api.example.com/api/v1/channels/connections/a%2Fb/test')
  })

  it('disconnects with a POST and reads the connection back', async () => {
    const { client, call } = setup({ ...connection, status: 'disconnected' })
    const result = await disconnectConnection(client, 's1', 'c1')
    expect(call()[0]).toBe('https://api.example.com/api/v1/channels/connections/c1/disconnect')
    expect(result.status).toBe('disconnected')
  })

  it('names a connection with a PUT of the label, and sends null to clear it', async () => {
    const named = setup({ ...connection, label: 'Main', displayName: 'Main' })
    const result = await renameConnection(named.client, 's1', 'c1', 'Main')
    expect(named.call()[0]).toBe('https://api.example.com/api/v1/channels/connections/c1/label')
    expect((named.call()[1] as RequestInit).method).toBe('PUT')
    expect(bodyOf(named.call()[1])).toEqual({ label: 'Main' })
    expect(result).toMatchObject({ label: 'Main', accountName: '+57 300 0000000' })

    const cleared = setup(connection)
    await renameConnection(cleared.client, 's1', 'c1', null)
    expect(bodyOf(cleared.call()[1])).toEqual({ label: null })
  })

  it('replaces a token with a POST to the connection, the secret in the body and never in the url', async () => {
    const { client, call } = setup(connection)
    await updateConnectionToken(client, 's1', 'c1', { accessToken: 'secret-new' })
    const [url, init] = call()
    expect(url).toBe('https://api.example.com/api/v1/channels/connections/c1/token')
    expect(String(url)).not.toContain('secret-new')
    expect((init as RequestInit).method).toBe('POST')
    expect(bodyOf(init)).toEqual({ credentials: { accessToken: 'secret-new' } })
  })

  it('refuses an answer of a connection with no label or account name (an api older than the page)', async () => {
    const old: Record<string, unknown> = { ...connection }
    delete old['label']
    delete old['accountName']
    const { client } = setup(old)
    await expect(renameConnection(client, 's1', 'c1', 'x')).rejects.toBeDefined()
  })

  it('asks for the page the cursor names, and for the state of the list', async () => {
    const { client, call } = setup({ data: [], nextCursor: null, hasMore: false })
    await fetchConnections(client, 's1', 'past', 'abc_-123')
    expect(call()[0]).toBe(
      'https://api.example.com/api/v1/channels/connections?state=past&cursor=abc_-123'
    )
  })

  it('refuses an answer that is not a page of connections', async () => {
    const { client } = setup({ data: [{ id: 'c1' }], nextCursor: null, hasMore: false })
    await expect(fetchConnections(client, 's1', 'live', null)).rejects.toBeDefined()
    const old = setup([connection])
    await expect(fetchConnections(old.client, 's1', 'live', null)).rejects.toBeDefined()
  })

  it('surfaces the code the api refused with', async () => {
    const { client } = setup(
      {
        error: { code: 'CHANNEL_CREDENTIALS_INVALID', message: 'x', metadata: {} },
        correlationId: 'c'
      },
      400
    )
    await expect(connectChannel(client, 's1', 'whatsapp', {})).rejects.toMatchObject({
      code: 'CHANNEL_CREDENTIALS_INVALID'
    })
    await expect(connectChannel(client, 's1', 'whatsapp', {})).rejects.toBeInstanceOf(ApiError)
  })
})

describe('the widget requests', () => {
  it('reads the widget of a connection', async () => {
    const { client, call } = setup(widget)
    await expect(fetchWidget(client, 's1', 'c1')).resolves.toEqual(widget)
    expect(call()[0]).toBe('https://api.example.com/api/v1/channels/connections/c1/widget')
  })

  it('puts the sites and the pre-chat switch on their own routes', async () => {
    const origins = setup(widget)
    await saveWidgetOrigins(origins.client, 's1', 'c1', ['https://a.com'])
    expect(origins.call()[0]).toBe(
      'https://api.example.com/api/v1/channels/connections/c1/widget/origins'
    )
    expect(origins.call()[1]?.method).toBe('PUT')
    expect(JSON.parse(origins.call()[1]?.body as string)).toEqual({
      siteOrigins: ['https://a.com']
    })

    const preChat = setup({ ...widget, preChatEnabled: true })
    const saved = await saveWidgetPreChat(preChat.client, 's1', 'c1', true)
    expect(preChat.call()[0]).toBe(
      'https://api.example.com/api/v1/channels/connections/c1/widget/pre-chat'
    )
    expect(JSON.parse(preChat.call()[1]?.body as string)).toEqual({ enabled: true })
    expect(saved.preChatEnabled).toBe(true)
  })
})

describe('the plugin requests', () => {
  it('reads the catalog with the manifest of each channel', async () => {
    const { client, call } = setup([entry, { ...entry, id: 'x', channel: null }])
    const read = await fetchPluginCatalog(client, 's1')
    expect(call()[0]).toBe('https://api.example.com/api/v1/plugins/available')
    expect(read[0]?.channel?.connectFields[0]?.secret).toBe(true)
    expect(read[1]?.channel).toBeNull()
  })

  it('installs by plugin id and uninstalls by installation id', async () => {
    const install = setup(entry, 201)
    await installPlugin(install.client, 's1', 'whatsapp')
    expect(install.call()[0]).toBe('https://api.example.com/api/v1/plugins/install')
    expect(JSON.parse(install.call()[1]?.body as string)).toEqual({ pluginId: 'whatsapp' })

    const revoke = setup({ ...entry, installed: false })
    const result = await uninstallPlugin(revoke.client, 's1', 'i1')
    expect(revoke.call()[0]).toBe('https://api.example.com/api/v1/plugins/i1/revoke')
    expect(result.installed).toBe(false)
  })
})

describe('the login with Facebook requests', () => {
  const entry = {
    id: 'messenger',
    name: 'Messenger',
    authorName: 'Platform',
    type: 'channel',
    isOfficial: true,
    installed: true,
    installationId: 'i1',
    activeConnections: 0
  }

  it('reads the login a plugin declares, and takes a server that does not say as having none', async () => {
    const oauth = {
      dialogOrigin: 'https://login.acme.test',
      providerName: { es: 'Acme', en: 'Acme' },
      linkedAccount: null,
      assetIdPattern: '^\\d{1,32}$'
    }
    const on = setup([{ ...entry, channel: { connectFields: [], callbackUrl: null, oauth } }])
    expect((await fetchPluginCatalog(on.client, 'store-1'))[0]?.channel?.oauth).toEqual(oauth)
    const older = setup([{ ...entry, channel: { connectFields: [], callbackUrl: null } }])
    expect((await fetchPluginCatalog(older.client, 'store-1'))[0]?.channel?.oauth).toBeNull()
    const bad = setup([
      {
        ...entry,
        channel: {
          connectFields: [],
          callbackUrl: null,
          oauth: { ...oauth, dialogOrigin: 'http://login.acme.test/x' }
        }
      }
    ])
    expect((await fetchPluginCatalog(bad.client, 'store-1'))[0]?.channel?.oauth).toBeNull()
  })

  it('starts with a POST to the plugin and reads the address back', async () => {
    const { client, call } = setup({ authorizeUrl: 'https://www.facebook.com/v23.0/dialog/oauth' })
    await expect(startOAuthLogin(client, 'store-1', 'messenger')).resolves.toEqual({
      authorizeUrl: 'https://www.facebook.com/v23.0/dialog/oauth'
    })
    expect(call()[0]).toBe(
      'https://api.example.com/api/v1/channels/connections/oauth/messenger/start'
    )
    expect((call()[1] as RequestInit).method).toBe('POST')
  })

  it('starts a repair with the connection in the body and never in the address', async () => {
    const { client, call } = setup({ authorizeUrl: 'https://www.facebook.com/v23.0/dialog/oauth' })
    await startOAuthLogin(client, 'store-1', 'messenger', 'c1')
    expect(bodyOf(call()[1])).toEqual({ connectionId: 'c1' })
    expect(call()[0]).not.toContain('c1')
  })

  it('sends no body to start a login that repairs nothing', async () => {
    const { client, call } = setup({ authorizeUrl: 'https://www.facebook.com/v23.0/dialog/oauth' })
    await startOAuthLogin(client, 'store-1', 'messenger')
    expect(bodyOf(call()[1])).toBeUndefined()
  })

  it('reads the connection a session repairs and its account, and none from an api that does not say', async () => {
    const bound = setup({
      pluginId: 'messenger',
      connectionId: 'c1',
      repairAccountId: '1100',
      assets: []
    })
    const view = await fetchOAuthAssets(bound.client, 'store-1', 'S'.repeat(43))
    expect(view.connectionId).toBe('c1')
    expect(view.repairAccountId).toBe('1100')
    const older = setup({ pluginId: 'messenger', assets: [] })
    const none = await fetchOAuthAssets(older.client, 'store-1', 'S'.repeat(43))
    expect(none.connectionId).toBeNull()
    expect(none.repairAccountId).toBeNull()
  })

  it('reads the Pages of a session and keeps only the three fields it draws', async () => {
    const { client, call } = setup({
      pluginId: 'instagram',
      assets: [{ id: '1', name: 'Page', linkedAccount: { id: '2', username: null }, token: 'LEAK' }]
    })
    const answer = await fetchOAuthAssets(client, 'store-1', 'S'.repeat(43))
    expect(answer.assets[0]).toEqual({
      id: '1',
      name: 'Page',
      linkedAccount: { id: '2', username: null }
    })
    expect(call()[0]).toBe(
      `https://api.example.com/api/v1/channels/connections/oauth/sessions/${'S'.repeat(43)}/assets`
    )
    expect(new Headers((call()[1] as RequestInit).headers).get(TenantHeaders.STORE_ID)).toBe(
      'store-1'
    )
  })

  it('completes with the number of the Page in the body, never in the address', async () => {
    const { client, call } = setup(connection)
    await completeOAuth(client, 'store-1', 'S'.repeat(43), '1100')
    expect(bodyOf(call()[1])).toEqual({ assetId: '1100' })
    expect(call()[0]).not.toContain('1100')
    expect((call()[1] as RequestInit).method).toBe('POST')
  })

  it('drops a session with a DELETE', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    const client = createApiClient({
      baseUrl: 'https://api.example.com',
      getAccessToken: () => 'token',
      refreshAccessToken: () => Promise.resolve('token'),
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    await expect(cancelOAuth(client, 'store-1', 'S'.repeat(43))).resolves.toBeUndefined()
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('DELETE')
  })

  it('encodes the id of a session it puts in a path', async () => {
    const { client, call } = setup({ pluginId: 'messenger', assets: [] })
    await fetchOAuthAssets(client, 'store-1', 'a/b?c')
    expect(call()[0]).toContain('a%2Fb%3Fc')
  })
})
