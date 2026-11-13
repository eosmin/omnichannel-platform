import { createApiClient } from './api-client'
import {
  connectCarrier,
  fetchAllCarrierConnections,
  fetchCarrierLocations,
  fetchCarrierRegistry,
  fetchCarrierStatusCatalog,
  fetchStatusMappings,
  putStatusMapping,
  removeStatusMapping,
  rotateCarrierWebhookSecret,
  updateCarrier
} from './carriers-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(...responses: Response[]) {
  const queue = [...responses]
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return Promise.resolve((next as Response).clone())
  })
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const connection = {
  id: 'c1',
  carrierId: 'forza',
  carrierName: 'Courier',
  displayName: 'Main',
  status: 'active',
  hasCredentials: true,
  hasWebhookSecret: true,
  webhookUrl: 'https://api.example.com/api/v1/webhooks/carriers/c1',
  capabilities: ['create_shipment'],
  isDefault: true,
  defaultServiceCode: null,
  defaultShippingPayer: 'sender',
  labelFormat: 'pdf_100x150',
  contact: null,
  guidePrefix: null,
  services: [],
  pickupEnabled: false,
  pickupDays: [],
  pickupCutoffTime: null,
  autoPickup: false,
  autoPickupTime: null,
  pickupReminderMinutes: 30,
  pollIntervalMinutes: null,
  maxDeliveryAttempts: 3,
  defaultShippingFeeCents: null,
  minShippingFeeCents: null,
  maxShippingFeeCents: null,
  remittanceDeductsFee: false,
  openShipments: 0,
  openPickups: 0,
  lastHealthyAt: null,
  lastError: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z'
}

const bodyOf = (init: RequestInit): unknown => JSON.parse(init.body as string)

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>, index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

describe('carriers api', () => {
  it('follows the pages of the connections through the store of the request', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [connection], nextCursor: 'n1', hasMore: true }),
      json(200, { data: [{ ...connection, id: 'c2' }], nextCursor: null, hasMore: false })
    )

    const all = await fetchAllCarrierConnections(client, 's1')

    expect(all.map(row => row.id)).toEqual(['c1', 'c2'])
    expect(callOf(fetchImpl, 1).url).toContain('cursor=n1')
    expect(callOf(fetchImpl).headers.get('x-store-id')).toBe('s1')
  })

  it('stops following a cursor that never ends', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [connection], nextCursor: 'again', hasMore: true })
    )
    await fetchAllCarrierConnections(client, 's1')
    expect(fetchImpl.mock.calls.length).toBe(10)
  })

  it('connects and reads the secret that comes once', async () => {
    const { client, fetchImpl } = setup(json(201, { ...connection, webhookSecret: 'abc' }))

    const made = await connectCarrier(client, 's1', {
      carrierId: 'forza',
      credentials: { apiKey: 'k' }
    })

    expect(made.webhookSecret).toBe('abc')
    const call = callOf(fetchImpl)
    expect(call.init.method).toBe('POST')
    expect(call.url).toBe('https://api.example.com/api/v1/carriers')
    expect(bodyOf(call.init)).toEqual({
      carrierId: 'forza',
      credentials: { apiKey: 'k' }
    })
  })

  it('patches only what it is given and rotates the secret', async () => {
    const { client, fetchImpl } = setup(json(200, connection), json(200, { webhookSecret: 'new' }))

    await updateCarrier(client, 's1', 'c/1', { autoPickup: true })
    const rotated = await rotateCarrierWebhookSecret(client, 's1', 'c1')

    expect(callOf(fetchImpl).url).toBe('https://api.example.com/api/v1/carriers/c%2F1')
    expect(callOf(fetchImpl).init.method).toBe('PATCH')
    expect(rotated.webhookSecret).toBe('new')
    expect(callOf(fetchImpl, 1).url).toBe(
      'https://api.example.com/api/v1/carriers/c1/webhook-secret'
    )
  })

  it('maps a code, ignores it with null, and removes the row', async () => {
    const mapping = {
      providerCode: 'entregado',
      label: null,
      status: 'delivered',
      source: 'custom',
      updatedAt: '2026-11-12T10:00:00.000Z'
    }
    const { client, fetchImpl } = setup(
      json(200, mapping),
      json(200, { ...mapping, status: null }),
      new Response(null, { status: 204 })
    )

    await putStatusMapping(client, 's1', 'c1', 'entregado', 'delivered')
    const ignored = await putStatusMapping(client, 's1', 'c1', 'entregado', null)
    await removeStatusMapping(client, 's1', 'c1', 'entregado')

    expect(bodyOf(callOf(fetchImpl).init)).toEqual({ status: 'delivered' })
    expect(ignored.status).toBeNull()
    expect(callOf(fetchImpl, 2).init.method).toBe('DELETE')
    expect(callOf(fetchImpl, 2).url).toBe(
      'https://api.example.com/api/v1/carriers/c1/status-mappings/entregado'
    )
  })

  it('reads a page of mappings with its cursor', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))
    await fetchStatusMappings(client, 's1', 'c1', 'abc')
    expect(callOf(fetchImpl).url).toContain('/carriers/c1/status-mappings?')
    expect(callOf(fetchImpl).url).toContain('cursor=abc')
  })

  it("reads the connect fields of the registry, with a label as a key or as the plugin's own text", async () => {
    const entry = {
      id: 'c807',
      name: 'Carrier',
      version: '1.0.0',
      capabilities: [],
      shipmentCreation: 'pickup_bound',
      maxBatchSize: 3,
      hasCredentials: true,
      services: [],
      connectFields: [
        {
          key: 'password',
          labelKey: 'fields.password',
          label: null,
          helpKey: null,
          secret: true,
          required: true,
          multiple: false
        },
        {
          key: 'site',
          labelKey: null,
          label: { es: 'Sede', en: 'Site' },
          helpKey: 'fields.site_help',
          secret: false,
          required: false,
          multiple: false
        }
      ]
    }
    const { client } = setup(json(200, [entry]))
    const [read] = await fetchCarrierRegistry(client, 's1')
    expect(read?.connectFields.map(field => field.key)).toEqual(['password', 'site'])
    expect(read?.connectFields[0]?.secret).toBe(true)
  })

  it('asks for the places under a parent, with a search, through the store of the request', async () => {
    const place = { id: '21', name: 'Soyapango', parentId: '2' }
    const { client, fetchImpl } = setup(json(200, [place]), json(200, []))

    expect(
      await fetchCarrierLocations(client, 's1', 'c/1', { parentId: '2', search: 'soya' })
    ).toEqual([place])
    await fetchCarrierLocations(client, 's1', 'c1')

    expect(callOf(fetchImpl).url).toBe(
      'https://api.example.com/api/v1/carriers/c%2F1/locations?parentId=2&search=soya'
    )
    expect(callOf(fetchImpl).headers.get('x-store-id')).toBe('s1')
    expect(callOf(fetchImpl, 1).url).toBe('https://api.example.com/api/v1/carriers/c1/locations')
  })

  it('reads the status catalog of a connection', async () => {
    const entry = {
      providerCode: 'delivered',
      label: 'Delivered',
      defaultStatus: 'delivered',
      hasMapping: false,
      mappedStatus: null,
      source: null
    }
    const { client, fetchImpl } = setup(json(200, [entry]))
    expect(await fetchCarrierStatusCatalog(client, 's1', 'c1')).toEqual([entry])
    expect(callOf(fetchImpl).url).toBe('https://api.example.com/api/v1/carriers/c1/status-catalog')
  })
})
