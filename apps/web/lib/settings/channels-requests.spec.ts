import { ApiError, createApiClient } from '@platform/api-client'
import { TenantHeaders } from '@platform/core/auth'

import {
  connectChannel,
  disconnectConnection,
  fetchConnections,
  fetchPluginCatalog,
  fetchWidget,
  installPlugin,
  saveWidgetOrigins,
  saveWidgetPreChat,
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

const connection = {
  id: 'c1',
  pluginId: 'whatsapp',
  displayName: '+57 300 0000000',
  status: 'active',
  lastHealthyAt: '2026-11-02T10:00:00.000Z',
  lastError: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  capabilities: ['text', 'templates'],
  profile: null
}
const widget = {
  siteKey: 'pk_widget_x',
  allowedOrigins: ['https://a.com'],
  preChatEnabled: false,
  snippet: '<script></script>',
  connectSrc: ['https://api.example.com']
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
    const { client, call } = setup([connection])
    await expect(fetchConnections(client, 's1')).resolves.toEqual([connection])
    const [url, init] = call()
    expect(url).toBe('https://api.example.com/api/v1/channels/connections')
    expect((init?.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBe('s1')
  })

  it('keeps a status and a capability it does not know as the text it came as', async () => {
    const { client } = setup([{ ...connection, status: 'paused', capabilities: ['hologram'] }])
    const [read] = await fetchConnections(client, 's1')
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

  it('refuses an answer that is not a connection', async () => {
    const { client } = setup([{ id: 'c1' }])
    await expect(fetchConnections(client, 's1')).rejects.toBeDefined()
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
