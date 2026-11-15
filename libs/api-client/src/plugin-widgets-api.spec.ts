import { createApiClient } from './api-client'
import {
  callPluginWidgetBridge,
  fetchPluginWidgets,
  fetchPluginWidgetSettings,
  openPluginWidgetSession,
  setPluginWidgetVisible
} from './plugin-widgets-api'

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

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>) => {
  const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

const widget = {
  installationId: 'i1',
  pluginId: 'p1',
  pluginName: 'Acme',
  widgetId: 'info',
  name: 'Info',
  url: 'https://widgets.acme.example/panel',
  origin: 'https://widgets.acme.example',
  width: null,
  height: 400,
  refreshInterval: null
}

describe('plugin widgets api', () => {
  it('lists the widgets of the store in X-Store-Id', async () => {
    const { client, fetchImpl } = setup(json(200, [widget]))
    await expect(fetchPluginWidgets(client, 'store-1')).resolves.toEqual([widget])
    const { url, headers } = callOf(fetchImpl)
    expect(url).toBe('https://api.example.com/api/v1/plugin-widgets')
    expect(headers.get('x-store-id')).toBe('store-1')
  })

  it('reads the settings list with the visibility of each widget', async () => {
    const { client, fetchImpl } = setup(json(200, [{ ...widget, visible: false }]))
    const list = await fetchPluginWidgetSettings(client, 'store-1')
    expect(list[0]?.visible).toBe(false)
    expect(callOf(fetchImpl).url).toBe('https://api.example.com/api/v1/plugin-widgets/settings')
  })

  it('shows or hides one widget with a PUT whose path names the installation and the widget', async () => {
    const { client, fetchImpl } = setup(json(200, { ...widget, visible: true }))
    await setPluginWidgetVisible(client, 'store-1', 'i1', 'info', true)
    const { url, init } = callOf(fetchImpl)
    expect(url).toBe('https://api.example.com/api/v1/plugin-widgets/settings/i1/info')
    expect(init.method).toBe('PUT')
    expect(init.body).toBe(JSON.stringify({ visible: true }))
  })

  it('opens a session for one installation and one conversation', async () => {
    const { client, fetchImpl } = setup(
      json(201, { token: 'tok', expiresInSeconds: 300, origin: 'https://widgets.acme.example' })
    )
    await expect(
      openPluginWidgetSession(client, 'store-1', 'i1', 'c1', 'info')
    ).resolves.toMatchObject({
      token: 'tok',
      expiresInSeconds: 300
    })
    expect(callOf(fetchImpl).init.body).toBe(
      JSON.stringify({ installationId: 'i1', conversationId: 'c1', widgetId: 'info' })
    )
  })

  it('refuses a session answer with no token', async () => {
    const { client } = setup(json(201, { token: '', expiresInSeconds: 300, origin: 'x' }))
    await expect(
      openPluginWidgetSession(client, 'store-1', 'i1', 'c1', 'info')
    ).rejects.toBeDefined()
  })

  it('answers a bridge call with only the keys of the minimum view', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        type: 'platform.widget.response',
        id: 'r1',
        ok: true,
        data: {
          id: 'cu1',
          name: 'Ana',
          email: null,
          phone: null,
          locale: 'es',
          internalNote: 'must not reach a frame'
        }
      })
    )
    const answer = await callPluginWidgetBridge(client, 'store-1', 'tok', {
      type: 'platform.widget.request',
      id: 'r1',
      operation: 'customer.get'
    })
    expect(answer).toEqual({
      type: 'platform.widget.response',
      id: 'r1',
      ok: true,
      data: { id: 'cu1', name: 'Ana', email: null, phone: null, locale: 'es' }
    })
    expect(JSON.parse(callOf(fetchImpl).init.body as string)).toEqual({
      token: 'tok',
      request: { type: 'platform.widget.request', id: 'r1', operation: 'customer.get' }
    })
  })
})
