import { ApiError, createApiClient } from '@platform/api-client'
import { WebhookStatus } from '@platform/core/domain'

import { createApiKey, fetchApiKeys, revokeApiKey } from './api-keys-requests'
import { fetchRetention, saveRetention } from './retention-requests'
import {
  createWebhook,
  deleteWebhook,
  fetchWebhookDeliveries,
  fetchWebhooks,
  rotateWebhookSecret,
  updateWebhook
} from './webhooks-requests'

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
  const call = () => {
    const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
    return { url, init, headers: new Headers(init.headers) }
  }
  return { client, call }
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

const webhook = {
  id: 'w1',
  url: 'https://example.com/hook',
  events: ['order.created'],
  status: 'active',
  consecutiveFailures: 0,
  lastFailureAt: null,
  createdAt: '2026-11-15T10:00:00.000Z'
}

const delivery = {
  id: 'd1',
  event: 'order.created',
  statusCode: 500,
  durationMs: 120,
  success: false,
  error: 'bad_status',
  attempt: 1,
  createdAt: '2026-11-15T10:01:00.000Z'
}

describe('webhook requests', () => {
  it('lists the webhooks of the store in X-Store-Id', async () => {
    const { client, call } = setup([webhook])
    await expect(fetchWebhooks(client, 's-1')).resolves.toEqual([webhook])
    expect(call().url).toBe('https://api.example.com/api/v1/settings/webhooks')
    expect(call().headers.get('X-Store-Id')).toBe('s-1')
  })

  it('keeps a status it does not know as the text it came as', async () => {
    const { client } = setup([{ ...webhook, status: 'suspended' }])
    expect((await fetchWebhooks(client, 's-1'))[0]?.status).toBe('suspended')
  })

  it('creates a webhook and reads its secret from the answer', async () => {
    const { client, call } = setup({ ...webhook, secret: 'whsec_abc' }, 201)
    const created = await createWebhook(client, 's-1', {
      url: webhook.url,
      events: webhook.events
    })
    expect(created.secret).toBe('whsec_abc')
    expect(call().init.method).toBe('POST')
    expect(bodyOf(call().init)).toEqual({ url: webhook.url, events: webhook.events })
  })

  it('refuses an answer to a create that carries no secret', async () => {
    const { client } = setup(webhook, 201)
    await expect(createWebhook(client, 's-1', { url: webhook.url, events: [] })).rejects.toThrow()
  })

  it('patches only what it is given', async () => {
    const { client, call } = setup({ ...webhook, status: 'paused' })
    await updateWebhook(client, 's-1', 'w1', { status: WebhookStatus.PAUSED })
    expect(call().url).toBe('https://api.example.com/api/v1/settings/webhooks/w1')
    expect(call().init.method).toBe('PATCH')
    expect(bodyOf(call().init)).toEqual({ status: 'paused' })
  })

  it('deletes a webhook, the answer being empty', async () => {
    const { client, call } = setup(null, 204)
    await expect(deleteWebhook(client, 's-1', 'w1')).resolves.toBeUndefined()
    expect(call().init.method).toBe('DELETE')
  })

  it('asks for a new secret by POST and reads it once', async () => {
    const { client, call } = setup({ ...webhook, secret: 'whsec_new' })
    expect((await rotateWebhookSecret(client, 's-1', 'w1')).secret).toBe('whsec_new')
    expect(call().url).toBe('https://api.example.com/api/v1/settings/webhooks/w1/secret')
    expect(call().init.method).toBe('POST')
  })

  it('reads the log from a cursor and filters by outcome', async () => {
    const { client, call } = setup({ items: [delivery], nextCursor: 'c2' })
    const page = await fetchWebhookDeliveries(client, 's-1', 'w1', {
      cursor: 'c1',
      outcome: 'failed'
    })
    expect(page.nextCursor).toBe('c2')
    const url = new URL(call().url)
    expect(url.pathname).toBe('/api/v1/settings/webhooks/w1/deliveries')
    expect(url.searchParams.get('cursor')).toBe('c1')
    expect(url.searchParams.get('success')).toBe('false')
  })

  it('sends no filter for all, and success=true for the delivered', async () => {
    const all = setup({ items: [], nextCursor: null })
    await fetchWebhookDeliveries(all.client, 's-1', 'w1', { cursor: null, outcome: 'all' })
    expect(all.call().url).toBe('https://api.example.com/api/v1/settings/webhooks/w1/deliveries')
    const ok = setup({ items: [], nextCursor: null })
    await fetchWebhookDeliveries(ok.client, 's-1', 'w1', { cursor: null, outcome: 'succeeded' })
    expect(new URL(ok.call().url).searchParams.get('success')).toBe('true')
  })

  it('escapes the id of the webhook in the path', async () => {
    const { client, call } = setup(null, 204)
    await deleteWebhook(client, 's-1', 'a/b')
    expect(call().url).toContain('/settings/webhooks/a%2Fb')
  })

  it('surfaces the code of an error answer', async () => {
    const { client } = setup({ error: { code: 'VALIDATION_URL_NOT_ALLOWED', message: 'no' } }, 400)
    await expect(
      createWebhook(client, 's-1', { url: 'https://10.0.0.1', events: ['order.created'] })
    ).rejects.toBeInstanceOf(ApiError)
  })
})

const apiKey = {
  id: 'k1',
  name: 'Warehouse app',
  keyPrefix: 'pk_live_abcd',
  scopes: ['orders:view'],
  status: 'active',
  lastUsedAt: null,
  expiresAt: null,
  createdAt: '2026-11-15T10:00:00.000Z',
  revokedAt: null
}

describe('api key requests', () => {
  it('lists the keys: only the prefix, never the key', async () => {
    const { client, call } = setup([apiKey])
    const keys = await fetchApiKeys(client, 's-1')
    expect(keys).toEqual([apiKey])
    expect(call().url).toBe('https://api.example.com/api/v1/settings/api-keys')
    expect(JSON.stringify(keys)).not.toContain('"key"')
  })

  it('makes a key and reads it from the answer, once', async () => {
    const { client, call } = setup({ ...apiKey, key: 'pk_live_secret' }, 201)
    const made = await createApiKey(client, 's-1', {
      name: 'Warehouse app',
      scopes: ['orders:view'],
      expiresAt: '2027-01-01T05:59:59.000Z'
    })
    expect(made.key).toBe('pk_live_secret')
    expect(bodyOf(call().init)).toEqual({
      name: 'Warehouse app',
      scopes: ['orders:view'],
      expiresAt: '2027-01-01T05:59:59.000Z'
    })
  })

  it('refuses an answer to a create that carries no key', async () => {
    const { client } = setup(apiKey, 201)
    await expect(
      createApiKey(client, 's-1', { name: 'x', scopes: ['orders:view'] })
    ).rejects.toThrow()
  })

  it('revokes by DELETE and gets the row back as revoked', async () => {
    const { client, call } = setup({
      ...apiKey,
      status: 'revoked',
      revokedAt: '2026-11-15T11:00:00.000Z'
    })
    const revoked = await revokeApiKey(client, 's-1', 'k1')
    expect(revoked.status).toBe('revoked')
    expect(call().init.method).toBe('DELETE')
    expect(call().url).toBe('https://api.example.com/api/v1/settings/api-keys/k1')
  })
})

const retention = {
  conversationDays: 365,
  mediaDays: 365,
  analyticsDays: 395,
  notificationDays: 90
}

describe('retention requests', () => {
  it('reads the four windows', async () => {
    const { client, call } = setup(retention)
    await expect(fetchRetention(client, 's-1')).resolves.toEqual(retention)
    expect(call().url).toBe('https://api.example.com/api/v1/settings/retention')
  })

  it('puts the four windows at once', async () => {
    const { client, call } = setup({ ...retention, mediaDays: 30 })
    const saved = await saveRetention(client, 's-1', { ...retention, mediaDays: 30 })
    expect(saved.mediaDays).toBe(30)
    expect(call().init.method).toBe('PUT')
    expect(bodyOf(call().init)).toEqual({ ...retention, mediaDays: 30 })
  })

  it('refuses an answer that lacks a window', async () => {
    const { client } = setup({ conversationDays: 365 })
    await expect(fetchRetention(client, 's-1')).rejects.toThrow()
  })
})
