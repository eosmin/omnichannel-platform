import { createApiClient } from './api-client'
import {
  addPickupShipments,
  cancelPickup,
  confirmPickup,
  fetchPickupManifest,
  fetchPickups,
  removePickupShipment
} from './pickups-api'
import {
  cancelShipment,
  checkShipmentWithCarrier,
  fetchShipment,
  fetchShipmentLabel,
  fetchShipmentList,
  markShipmentVoided,
  setShipmentStatus
} from './shipments-api'

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

const bodyOf = (init: RequestInit): unknown =>
  JSON.parse(typeof init.body === 'string' ? init.body : '')

const shipment = {
  id: 'sh1',
  orderId: 'o1',
  orderNumber: '1001',
  connectionId: 'c1',
  connectionName: 'Local',
  carrierId: 'x',
  kind: 'outbound',
  returnId: null,
  status: 'label_created',
  serviceCode: 'std',
  shippingPayer: 'sender',
  codAmountCents: null,
  codStatus: 'not_applicable',
  currency: 'USD',
  packageCount: 1,
  failedAttempts: 0,
  guideNumber: 'G-1',
  trackingUrl: null,
  hasLabel: true,
  carrierCostCents: null,
  refundStatus: 'not_applicable',
  pickupId: null,
  lastError: null,
  cancelRequestedAt: null,
  cancelledAt: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z'
}

const pickup = {
  id: 'p1',
  connectionId: 'c1',
  connectionName: 'Local',
  carrierId: 'x',
  pickupDate: '2026-11-13',
  status: 'requested',
  packageCount: 2,
  revision: 1,
  providerPickupId: null,
  windowStart: null,
  windowEnd: null,
  requestedBy: 'system',
  lastError: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  updatedAt: '2026-11-12T10:00:00.000Z'
}

describe('shipments api', () => {
  it('lists the guides through the store with only the filters that were given', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [shipment], nextCursor: null, hasMore: false })
    )
    const page = await fetchShipmentList(client, 's1', {
      status: 'requires_review',
      connectionId: '',
      from: '2026-11-01T00:00:00.000Z',
      cursor: 'abc'
    })
    const { url, headers } = callOf(fetchImpl)
    expect(page.data[0]?.guideNumber).toBe('G-1')
    expect(url).toContain('status=requires_review')
    expect(url).toContain('from=2026-11-01T00%3A00%3A00.000Z')
    expect(url).toContain('cursor=abc')
    expect(url).not.toContain('connectionId')
    expect(url).not.toContain('orderId')
    expect(headers.get('x-store-id')).toBe('s1')
  })

  it('reads one guide with its history, an unmapped line keeping the carrier text and no status', async () => {
    const { client } = setup(
      json(200, {
        ...shipment,
        events: [
          {
            id: 'e1',
            status: null,
            rawStatus: 'weird code',
            description: null,
            occurredAt: '2026-11-12T11:00:00.000Z',
            source: 'webhook'
          }
        ]
      })
    )
    const detail = await fetchShipment(client, 's1', 'sh1')
    expect(detail.events[0]).toMatchObject({ status: null, rawStatus: 'weird code' })
  })

  it('posts the cancel, the voided mark, the check and the manual status to the guide', async () => {
    for (const [call, path] of [
      [
        (c: ReturnType<typeof setup>['client']) => cancelShipment(c, 's1', 'sh1'),
        '/shipments/sh1/cancel'
      ],
      [
        (c: ReturnType<typeof setup>['client']) => markShipmentVoided(c, 's1', 'sh1'),
        '/shipments/sh1/mark-voided'
      ],
      [
        (c: ReturnType<typeof setup>['client']) =>
          setShipmentStatus(c, 's1', 'sh1', { status: 'failed' }),
        '/shipments/sh1/status'
      ]
    ] as const) {
      const { client, fetchImpl } = setup(json(200, shipment))
      await call(client)
      const { url, init } = callOf(fetchImpl)
      expect(url).toContain(path)
      expect(init.method).toBe('POST')
    }
    const { client, fetchImpl } = setup(json(200, { found: false, shipment }))
    expect((await checkShipmentWithCarrier(client, 's1', 'sh1')).found).toBe(false)
    expect(callOf(fetchImpl).url).toContain('/shipments/sh1/check')
  })

  it('sends the manual status as the body and nothing else', async () => {
    const { client, fetchImpl } = setup(json(200, shipment))
    await setShipmentStatus(client, 's1', 'sh1', { status: 'label_created', guideNumber: 'G-9' })
    expect(bodyOf(callOf(fetchImpl).init)).toEqual({
      status: 'label_created',
      guideNumber: 'G-9'
    })
  })

  it('asks for the label link when pressed', async () => {
    const { client, fetchImpl } = setup(
      json(200, { url: 'https://files/x.pdf', filename: 'x.pdf' })
    )
    expect((await fetchShipmentLabel(client, 's1', 'sh1')).filename).toBe('x.pdf')
    expect(callOf(fetchImpl).url).toContain('/shipments/sh1/label')
  })
})

describe('pickups api', () => {
  it('lists the pickups through the store with the filters given', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [pickup], nextCursor: null, hasMore: false })
    )
    await fetchPickups(client, 's1', { status: 'manual_required', from: '2026-11-01', to: '' })
    const { url, headers } = callOf(fetchImpl)
    expect(url).toContain('/pickups?')
    expect(url).toContain('status=manual_required')
    expect(url).toContain('from=2026-11-01')
    expect(url).not.toContain('to=')
    expect(headers.get('x-store-id')).toBe('s1')
  })

  it('joins guides and answers what could not join with its reason', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        pickup,
        created: false,
        joined: ['sh1'],
        waiting: [{ shipmentId: 'sh2', reason: 'cutoff_passed' }]
      })
    )
    const answer = await addPickupShipments(client, 's1', 'p1', {
      shipmentIds: ['sh1', 'sh2'],
      confirmAfterCutoff: true
    })
    const { url, init } = callOf(fetchImpl)
    expect(url).toContain('/pickups/p1/shipments')
    expect(init.method).toBe('POST')
    expect(bodyOf(init)).toEqual({
      shipmentIds: ['sh1', 'sh2'],
      confirmAfterCutoff: true
    })
    expect(answer.waiting[0]?.reason).toBe('cutoff_passed')
  })

  it('removes one guide with a DELETE, confirms and cancels with a POST', async () => {
    const removed = setup(json(200, pickup))
    await removePickupShipment(removed.client, 's1', 'p1', 'sh1')
    expect(callOf(removed.fetchImpl).url).toContain('/pickups/p1/shipments/sh1')
    expect(callOf(removed.fetchImpl).init.method).toBe('DELETE')

    const confirmed = setup(json(200, pickup))
    await confirmPickup(confirmed.client, 's1', 'p1')
    expect(callOf(confirmed.fetchImpl).url).toContain('/pickups/p1/confirm')
    expect(callOf(confirmed.fetchImpl).init.method).toBe('POST')

    const cancelled = setup(json(200, pickup))
    await cancelPickup(cancelled.client, 's1', 'p1')
    expect(callOf(cancelled.fetchImpl).url).toContain('/pickups/p1/cancel')
  })

  it('reads the manifest of a pickup', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        pickupId: 'p1',
        connectionName: 'Local',
        pickupDate: '2026-11-13',
        status: 'manual_required',
        packageCount: 1,
        windowStart: null,
        windowEnd: null,
        lines: [
          {
            shipmentId: 'sh1',
            guideNumber: 'G-1',
            recipient: 'Ana',
            orderNumber: '1001',
            packageCount: 1
          }
        ]
      })
    )
    const manifest = await fetchPickupManifest(client, 's1', 'p1')
    expect(manifest.lines[0]?.recipient).toBe('Ana')
    expect(callOf(fetchImpl).url).toContain('/pickups/p1/manifest')
  })
})
