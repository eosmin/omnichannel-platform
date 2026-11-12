import { createApiClient } from './api-client'
import {
  deleteOrderTemplate,
  fetchOrderTemplates,
  previewOrderTemplate,
  putOrderTemplate
} from './order-templates-api'

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

const template = {
  id: 't1',
  kind: 'order_shipped',
  locale: 'es',
  body: 'Hola {{customerName}}',
  autoSend: true,
  attachSummary: false,
  channelTemplate: null,
  variables: ['customerName'],
  warnings: [],
  updatedAt: '2026-11-12T10:00:00.000Z'
}

describe('order templates requests', () => {
  it('lists the templates of the store in X-Store-Id', async () => {
    const { client, fetchImpl } = setup(json(200, [template]))
    await expect(fetchOrderTemplates(client, 's-1')).resolves.toEqual([template])
    const call = callOf(fetchImpl)
    expect(call.url).toBe('https://api.example.com/api/v1/order-templates')
    expect(call.headers.get('X-Store-Id')).toBe('s-1')
  })

  it('keeps a kind or a warning it does not know as the text it came as', async () => {
    const { client } = setup(json(200, [{ ...template, kind: 'future_kind', warnings: ['new'] }]))
    const views = await fetchOrderTemplates(client, 's-1')
    expect(views[0]?.kind).toBe('future_kind')
    expect(views[0]?.warnings).toEqual(['new'])
  })

  it('puts a template by kind and language, with the link to a channel template', async () => {
    const { client, fetchImpl } = setup(json(200, template))
    const channelTemplate = {
      pluginId: 'p',
      name: 'shipped',
      language: 'es_MX',
      variables: ['customerName' as const]
    }
    await putOrderTemplate(client, 's-1', 'order_shipped', 'es', {
      body: 'Hola',
      autoSend: false,
      attachSummary: true,
      channelTemplate
    })
    const call = callOf(fetchImpl)
    expect(call.url).toBe('https://api.example.com/api/v1/order-templates/order_shipped/locales/es')
    expect(call.init.method).toBe('PUT')
    expect(JSON.parse(call.init.body as string)).toEqual({
      body: 'Hola',
      autoSend: false,
      attachSummary: true,
      channelTemplate
    })
  })

  it('deletes a template and takes the empty answer', async () => {
    const { client, fetchImpl } = setup(new Response(null, { status: 204 }))
    await expect(deleteOrderTemplate(client, 's-1', 'order_shipped', 'en')).resolves.toBeUndefined()
    expect(callOf(fetchImpl).init.method).toBe('DELETE')
  })

  it('previews the text being edited with its language', async () => {
    const { client, fetchImpl } = setup(
      json(200, { text: 'Hola Ana', variables: ['customerName'] })
    )
    await expect(
      previewOrderTemplate(client, 's-1', 'Hola {{customerName}}', 'es')
    ).resolves.toEqual({
      text: 'Hola Ana',
      variables: ['customerName']
    })
    const call = callOf(fetchImpl)
    expect(call.url).toBe('https://api.example.com/api/v1/order-templates/preview')
    expect(call.init.method).toBe('POST')
    expect(JSON.parse(call.init.body as string)).toEqual({
      body: 'Hola {{customerName}}',
      locale: 'es'
    })
  })
})
