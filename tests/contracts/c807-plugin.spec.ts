import { C807Plugin } from '@platform/carriers/c807'
import { MemoryCarrierTokenCache, ShipmentStatus, ShippingPayer } from '@platform/core/domain'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError,
  PickupBatchOutcomes
} from '@platform/plugins/sdk'

import {
  C807_FAKE_PASSWORD,
  C807_FAKE_USERNAME,
  C807_FAKE_WEBHOOK_SECRET,
  type FakeC807,
  fakeC807
} from '../builders/c807-fixtures'
import { buildCarrierContext, buildCreateShipmentParams } from '../builders/carrier-plugin'

const context = buildCarrierContext({
  credentials: { username: C807_FAKE_USERNAME, password: C807_FAKE_PASSWORD },
  metadata: { deliveryType: 'NRML', site: 3 }
})
const shipment = (overrides: Parameters<typeof buildCreateShipmentParams>[0] = {}) =>
  buildCreateShipmentParams({
    recipient: {
      name: 'Ana Recipient',
      phones: ['71234567', '72345678'],
      email: 'ana@example.com',
      address: { line1: '5 Customer St', city: 'Santa Tecla', country: 'SV' },
      locationIds: { departmentId: '2', municipalityId: '4' }
    },
    ...overrides
  })
const batch = (shipments = [shipment()]) => ({
  idempotencyKey: 'batch-1',
  pickup: {
    window: { date: '2026-12-01', from: '09:00', to: '12:00' },
    packageCount: shipments.length
  },
  shipments
})

let carrier: FakeC807
let cache: MemoryCarrierTokenCache
let plugin: C807Plugin

beforeEach(() => {
  carrier = fakeC807()
  cache = new MemoryCarrierTokenCache()
  plugin = new C807Plugin(cache)
  jest.spyOn(globalThis, 'fetch').mockImplementation(carrier.fetch)
})
afterEach(() => jest.restoreAllMocks())

describe('C807: what it declares', () => {
  it('declares what its documentation confirms and nothing it cannot do', () => {
    expect([...plugin.capabilities].sort()).toEqual(
      [
        'cod',
        'fetch_status',
        'pickup_bound_guides',
        'requires_location_ids',
        'webhook_status'
      ].sort()
    )
    for (const method of [
      'cancelShipment',
      'modifyPickup',
      'cancelPickup',
      'requestPickup',
      'createShipment'
    ]) {
      expect(plugin).not.toHaveProperty(method)
    }
    expect(plugin.webhookTrust).toBe('shared_secret')
  })
})

describe('C807: connecting', () => {
  it('proves the credentials and keeps the type of delivery and the site as metadata', async () => {
    const connected = await plugin.connect({
      storeId: 'store-1',
      credentials: {
        username: C807_FAKE_USERNAME,
        password: C807_FAKE_PASSWORD,
        deliveryType: 'nrml',
        site: '3'
      }
    })
    expect(connected.credentials).toEqual({
      username: C807_FAKE_USERNAME,
      password: C807_FAKE_PASSWORD
    })
    expect(connected.metadata).toEqual({
      deliveryType: 'NRML',
      environment: 'production',
      weightUnit: 'LB',
      site: 3
    })
    // There is no connection yet, so no token is kept for one
    expect(await cache.get('store-1', 'connection-1')).toBeNull()
  })

  it('talks to the production host by default and to the sandbox host when the connection says so', async () => {
    await plugin.lookupLocations(context, {})
    expect(carrier.calls.every(call => call.host === 'app.c807.com')).toBe(true)
    const sandbox = buildCarrierContext({
      ...context,
      connectionId: 'connection-sandbox',
      metadata: { deliveryType: 'NRML', environment: 'sandbox' }
    })
    await plugin.lookupLocations(sandbox, {})
    expect(carrier.calls.at(-1)?.host).toBe('qaapp.c807.com')
    expect(
      carrier.calls.filter(call => call.path.endsWith('get_token')).map(call => call.host)
    ).toEqual(['app.c807.com', 'qaapp.c807.com'])
  })

  it('connects in the sandbox, and refuses an environment it does not know', async () => {
    const connected = await plugin.connect({
      storeId: 'store-1',
      credentials: {
        username: C807_FAKE_USERNAME,
        password: C807_FAKE_PASSWORD,
        deliveryType: 'NRML',
        environment: 'sandbox'
      }
    })
    expect(connected.metadata).toMatchObject({ environment: 'sandbox' })
    expect(carrier.calls[0]?.host).toBe('qaapp.c807.com')
    await expect(
      plugin.connect({
        storeId: 'store-1',
        credentials: {
          username: C807_FAKE_USERNAME,
          password: C807_FAKE_PASSWORD,
          deliveryType: 'NRML',
          environment: 'https://evil.example'
        }
      })
    ).rejects.toBeInstanceOf(CarrierRejectedError)
  })

  it('takes a blank site of the form as no site', async () => {
    const connected = await plugin.connect({
      storeId: 'store-1',
      credentials: {
        username: C807_FAKE_USERNAME,
        password: C807_FAKE_PASSWORD,
        deliveryType: 'NRML',
        site: ''
      }
    })
    expect(connected.metadata).toEqual({
      deliveryType: 'NRML',
      environment: 'production',
      weightUnit: 'LB'
    })
  })

  it('refuses a wrong password as an authentication failure', async () => {
    await expect(
      plugin.connect({
        storeId: 'store-1',
        credentials: { username: C807_FAKE_USERNAME, password: 'nope', deliveryType: 'NRML' }
      })
    ).rejects.toBeInstanceOf(CarrierAuthError)
  })

  it('refuses data that is not valid before it calls anyone', async () => {
    await expect(
      plugin.connect({ storeId: 'store-1', credentials: { username: 'a' } })
    ).rejects.toBeInstanceOf(CarrierRejectedError)
    expect(carrier.calls).toHaveLength(0)
  })

  it("says a health check failed without saying why in the carrier's words", async () => {
    const bad = buildCarrierContext({
      credentials: { username: C807_FAKE_USERNAME, password: 'nope' },
      metadata: {}
    })
    await expect(plugin.healthCheck(bad)).resolves.toMatchObject({
      healthy: false,
      error: 'The credentials were rejected'
    })
    await expect(plugin.healthCheck(context)).resolves.toMatchObject({ healthy: true })
  })

  it('forgets the token when the connection is closed', async () => {
    await plugin.lookupLocations(context, {})
    expect(await cache.get('store-1', 'connection-1')).not.toBeNull()
    await plugin.disconnect(context)
    expect(await cache.get('store-1', 'connection-1')).toBeNull()
  })
})

describe('C807: the token', () => {
  it('asks for one token and keeps it for the next calls of the connection', async () => {
    await plugin.lookupLocations(context, {})
    await plugin.lookupLocations(context, {})
    await plugin.lookupLocations(context, { parentId: '2' })
    expect(carrier.tokens.issued).toBe(1)
  })

  it('asks for a new token once when the carrier answers 401, and repeats the call', async () => {
    await plugin.lookupLocations(context, {})
    carrier.expire(1)
    const places = await plugin.lookupLocations(context, {})
    expect(places).toHaveLength(2)
    expect(carrier.tokens.issued).toBe(2)
  })

  it('gives up on a second 401: the credentials are not accepted', async () => {
    await plugin.lookupLocations(context, {})
    carrier.expire(2)
    await expect(plugin.lookupLocations(context, {})).rejects.toBeInstanceOf(CarrierAuthError)
  })

  it('does not go on with the token of the old account when the credentials of the connection change', async () => {
    await plugin.lookupLocations(context, {})
    const edited = buildCarrierContext({
      ...context,
      credentials: { username: C807_FAKE_USERNAME, password: 'a-new-password' }
    })
    await expect(plugin.lookupLocations(edited, {})).rejects.toBeInstanceOf(CarrierAuthError)
  })

  it('asks the carrier once when several calls find the token gone at the same time', async () => {
    await cache.delete('store-1', 'connection-1')
    await Promise.all([
      plugin.lookupLocations(context, {}),
      plugin.lookupLocations(context, {}),
      plugin.lookupLocations(context, {})
    ])
    expect(carrier.tokens.issued).toBe(1)
  })

  it('works with the new token after a renewal, since the old one no longer does', async () => {
    await plugin.lookupLocations(context, {})
    carrier.expire(1)
    await plugin.lookupLocations(context, {})
    const last = carrier.calls[carrier.calls.length - 1]
    expect(last?.headers['authorization']).toBe('Bearer fake-token-do-not-leak-2')
  })

  it('shares nothing between stores', async () => {
    await plugin.lookupLocations(context, {})
    await plugin.lookupLocations(buildCarrierContext({ ...context, storeId: 'store-2' }), {})
    expect(carrier.tokens.issued).toBe(2)
  })
})

describe('C807: creating guides', () => {
  it('makes a pickup with the guides inside, one call, and a label for each', async () => {
    const result = await plugin.createShipmentsWithPickup(
      context,
      batch([shipment({ reference: 'A-1' }), shipment({ reference: 'A-2' })])
    )
    expect(result.pickupRef).toMatch(/^RECOLECTA-/)
    expect(result.shipments.map(entry => entry.outcome)).toEqual([
      PickupBatchOutcomes.CREATED,
      PickupBatchOutcomes.CREATED
    ])
    const create = carrier.calls.find(call => call.path.endsWith('set_registro'))
    expect(create?.body).toMatchObject({
      recolecta_fecha: '2026-12-01 09:00',
      tipo_entrega: 'NRML',
      sede: 3
    })
    expect(carrier.calls.filter(call => call.path.endsWith('get_pdf'))).toHaveLength(2)
    const first = result.shipments[0]
    if (first?.outcome !== PickupBatchOutcomes.CREATED) throw new Error('expected a guide')
    expect(first.shipment.label?.contentType).toBe('application/pdf')
    expect(first.shipment.trackingUrl).toContain('https://tracking.example.test/')
  })

  it('keeps a guide whose label could not be fetched: the label is asked for again later', async () => {
    const answer = carrier.fetch
    jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.endsWith('get_pdf') ? Promise.reject(new Error('down')) : answer(input, init)
    })
    const result = await plugin.createShipmentsWithPickup(context, batch())
    const entry = result.shipments[0]
    if (entry?.outcome !== PickupBatchOutcomes.CREATED) throw new Error('expected a guide')
    expect(entry.shipment.guideNumber).toBeTruthy()
    expect(entry.shipment.label).toBeUndefined()
  })

  it('leaves with its shipment the order C807 made no guide for', async () => {
    carrier.skip.add('A-2')
    const result = await plugin.createShipmentsWithPickup(
      context,
      batch([shipment({ reference: 'A-1' }), shipment({ reference: 'A-2' })])
    )
    expect(result.shipments.map(entry => entry.outcome)).toEqual([
      PickupBatchOutcomes.CREATED,
      PickupBatchOutcomes.REJECTED
    ])
  })

  it('refuses the batch when C807 made no guide at all', async () => {
    carrier.skip.add('A-1')
    await expect(
      plugin.createShipmentsWithPickup(context, batch([shipment({ reference: 'A-1' })]))
    ).rejects.toBeInstanceOf(CarrierRejectedError)
  })

  it('takes the first guide of an order with several packages', async () => {
    const result = await plugin.createShipmentsWithPickup(
      context,
      batch([shipment({ reference: 'M-1', packageCount: 2, parcels: [] })])
    )
    const entry = result.shipments[0]
    if (entry?.outcome !== PickupBatchOutcomes.CREATED) throw new Error('expected a guide')
    expect(entry.shipment.guideNumber).toBe('fake-1-M-1-1')
    const pdf = carrier.calls.find(call => call.path.endsWith('get_pdf'))
    expect(pdf?.body).toEqual({ guias: ['fake-1-M-1-1', 'fake-1-M-1-2'] })
  })

  it('refuses a batch bigger than it takes, before it calls', async () => {
    const many = Array.from({ length: 26 }, (_unused, index) =>
      shipment({ reference: `B-${index}` })
    )
    await expect(plugin.createShipmentsWithPickup(context, batch(many))).rejects.toBeInstanceOf(
      CarrierRejectedError
    )
    expect(carrier.calls).toHaveLength(0)
  })

  it('refuses an order C807 would refuse alone, and makes the guides of the others', async () => {
    const result = await plugin.createShipmentsWithPickup(
      context,
      batch([
        shipment({ reference: 'A-1' }),
        shipment({ reference: 'X'.repeat(30) }),
        shipment({ reference: 'A-3' })
      ])
    )
    expect(result.shipments.map(entry => entry.outcome)).toEqual([
      PickupBatchOutcomes.CREATED,
      PickupBatchOutcomes.REJECTED,
      PickupBatchOutcomes.CREATED
    ])
    const create = carrier.calls.find(call => call.path.endsWith('set_registro'))
    expect((create?.body as { guias: unknown[] }).guias).toHaveLength(2)
  })

  it('does not send an order number twice in one batch, and matches an order sent with spaces', async () => {
    const result = await plugin.createShipmentsWithPickup(
      context,
      batch([shipment({ reference: ' A-1 ' }), shipment({ reference: 'A-1' })])
    )
    expect(result.shipments.map(entry => entry.outcome)).toEqual([
      PickupBatchOutcomes.CREATED,
      PickupBatchOutcomes.REJECTED
    ])
  })

  it('refuses a connection whose environment it does not know, instead of sending it to production', async () => {
    const odd = buildCarrierContext({
      ...context,
      metadata: { deliveryType: 'NRML', environment: 'staging' }
    })
    await expect(plugin.lookupLocations(odd, {})).rejects.toBeInstanceOf(CarrierRejectedError)
    expect(carrier.calls).toHaveLength(0)
  })

  it('reads the environment however the owner typed it', async () => {
    const connected = await plugin.connect({
      storeId: 'store-1',
      credentials: {
        username: C807_FAKE_USERNAME,
        password: C807_FAKE_PASSWORD,
        deliveryType: 'NRML',
        environment: ' Sandbox '
      }
    })
    expect(connected.metadata).toMatchObject({ environment: 'sandbox' })
  })

  it('does not reuse the token of one environment in the other', async () => {
    await plugin.lookupLocations(context, {})
    const sandbox = buildCarrierContext({
      ...context,
      metadata: { deliveryType: 'NRML', environment: 'sandbox' }
    })
    await plugin.lookupLocations(sandbox, {})
    expect(carrier.tokens.issued).toBe(2)
  })

  it('refuses an order with no e-mail alone, and uses the fallback of the connection when it has one', async () => {
    const noEmail = shipment({ reference: 'N-1' })
    noEmail.recipient = { ...noEmail.recipient, email: undefined }
    const refused = await plugin.createShipmentsWithPickup(
      context,
      batch([shipment({ reference: 'N-0' }), noEmail])
    )
    expect(refused.shipments.map(entry => entry.outcome)).toEqual([
      PickupBatchOutcomes.CREATED,
      PickupBatchOutcomes.REJECTED
    ])
    const withFallback = buildCarrierContext({
      ...context,
      metadata: { deliveryType: 'NRML', fallbackEmail: 'tienda@example.com' }
    })
    const made = await plugin.createShipmentsWithPickup(withFallback, batch([noEmail]))
    expect(made.shipments[0]?.outcome).toBe(PickupBatchOutcomes.CREATED)
    const create = carrier.calls.filter(call => call.path.endsWith('set_registro')).at(-1)
    expect((create?.body as { guias: { correo: string }[] }).guias[0]?.correo).toBe(
      'tienda@example.com'
    )
  })

  it('shows what C807 says when it refuses a whole request, the way its errors come', async () => {
    const answer = carrier.fetch
    jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.endsWith('set_registro')
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                errores: [
                  { codigo: 5, mensaje: 'Guía 1, complete los datos.' },
                  { codigo: 5, mensaje: 'Guía 2, unidad inválida.' }
                ]
              }),
              { status: 400 }
            )
          )
        : answer(input, init)
    })
    await expect(plugin.createShipmentsWithPickup(context, batch())).rejects.toThrow(
      'Guía 1, complete los datos.; Guía 2, unidad inválida.'
    )
  })

  it('refuses the batch before it calls when C807 would refuse every shipment', async () => {
    await expect(
      plugin.createShipmentsWithPickup(context, batch([shipment({ reference: 'X'.repeat(30) })]))
    ).rejects.toBeInstanceOf(CarrierRejectedError)
    expect(carrier.calls).toHaveLength(0)
  })

  it('keeps the guides it made when the label call is refused for the token', async () => {
    const answer = carrier.fetch
    jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.endsWith('get_pdf')
        ? Promise.resolve(new Response(null, { status: 401 }))
        : answer(input, init)
    })
    const result = await plugin.createShipmentsWithPickup(context, batch())
    expect(result.pickupRef).toMatch(/^RECOLECTA-/)
    const entry = result.shipments[0]
    if (entry?.outcome !== PickupBatchOutcomes.CREATED) throw new Error('expected a guide')
    expect(entry.shipment.label).toBeUndefined()
  })

  it('sends each case with its type of service', async () => {
    await plugin.createShipmentsWithPickup(
      context,
      batch([
        shipment({ reference: 'T-1', cod: { amountCents: 1000, currency: 'USD' } }),
        shipment({ reference: 'T-2', shippingPayer: ShippingPayer.RECIPIENT }),
        shipment({ reference: 'T-3' })
      ])
    )
    const create = carrier.calls.find(call => call.path.endsWith('set_registro'))
    const guides = (create?.body as { guias: { tipo_servicio: string; monto_cce?: number }[] })
      .guias
    expect(guides.map(guide => guide.tipo_servicio)).toEqual(['CCE', 'SEC', 'SER'])
    expect(guides[0]?.monto_cce).toBe(10)
  })

  it('reports an answer it cannot read as an unknown outcome, because guides may exist', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.endsWith('set_registro')
        ? Promise.resolve(new Response('<html>oops</html>', { status: 200 }))
        : carrier.fetch(input, init)
    })
    await expect(plugin.createShipmentsWithPickup(context, batch())).rejects.toBeInstanceOf(
      CarrierUnavailableError
    )
  })

  it('reports a server error and a timeout as an unknown outcome, and a refusal as a refusal', async () => {
    const answer = carrier.fetch
    const respond = (status: number): void => {
      jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url.endsWith('set_registro')
          ? Promise.resolve(
              new Response(JSON.stringify({ mensaje: 'Municipio no valido' }), { status })
            )
          : answer(input, init)
      })
    }
    respond(502)
    await expect(plugin.createShipmentsWithPickup(context, batch())).rejects.toBeInstanceOf(
      CarrierUnavailableError
    )
    respond(422)
    await expect(plugin.createShipmentsWithPickup(context, batch())).rejects.toThrow(
      'Municipio no valido'
    )
    jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.endsWith('set_registro')
        ? Promise.reject(new Error('socket hang up'))
        : answer(input, init)
    })
    await expect(plugin.createShipmentsWithPickup(context, batch())).rejects.toBeInstanceOf(
      CarrierUnavailableError
    )
  })

  it('finds again what it made by the pickup, with the reference of each order', async () => {
    const made = await plugin.createShipmentsWithPickup(
      context,
      batch([shipment({ reference: 'A-1' }), shipment({ reference: 'A-2' })])
    )
    const found = await plugin.fetchPickup(context, { pickupRef: made.pickupRef })
    expect(found.shipments.map(guide => guide.reference)).toEqual(['A-1', 'A-2'])
  })

  it('fetches a label by the guide', async () => {
    const label = await plugin.fetchLabel(context, {
      reference: 'A-1',
      guideNumber: 'fake-1-A-1',
      format: 'pdf_100x150'
    })
    expect(Buffer.from(label.data).toString()).toContain('%PDF')
  })
})

describe('C807: status', () => {
  it('reads the history of a guide, oldest first, in the zone of the carrier', async () => {
    const events = await plugin.fetchStatus(context, [
      { reference: 'A-1', guideNumber: 'fake-1-A-1' }
    ])
    expect(events.map(event => event.rawStatus)).toEqual(['1', '10', '13'])
    expect(events[2]).toMatchObject({
      status: ShipmentStatus.PICKED_UP,
      occurredAt: '2026-12-01T14:30:00-06:00',
      guideNumber: 'fake-1-A-1'
    })
  })

  it('finds the guide by the order when the core has none', async () => {
    await plugin.createShipmentsWithPickup(context, batch([shipment({ reference: 'A-1' })]))
    const events = await plugin.fetchStatus(context, [{ reference: 'A-1' }])
    expect(events).toHaveLength(3)
    expect(events[0]?.guideNumber).toBe('fake-1-A-1')
  })

  it('reads a return in the history when the row says so', async () => {
    const answer = carrier.fetch
    jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.includes('get_historia')
        ? Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  estatus: 'Llegó a su destino',
                  codigo: '15',
                  fecha: '2026-12-02 10:00:00',
                  devolucion: true
                }
              ]),
              { status: 200 }
            )
          )
        : answer(input, init)
    })
    const events = await plugin.fetchStatus(context, [{ reference: 'A-1', guideNumber: 'g-1' }])
    expect(events[0]).toMatchObject({ status: ShipmentStatus.RETURNED, rawReason: 'devolucion' })
  })

  it('has nothing to say about an order C807 does not know', async () => {
    await expect(plugin.fetchStatus(context, [{ reference: 'unknown' }])).resolves.toEqual([])
  })

  it('reads a delivery that went back to the sender as a return, and a problem with its reason', async () => {
    const back = await plugin.handleWebhook({
      guia: 'g',
      codigo: '15',
      fecha: '2026-12-02 10:00:00',
      devolucion: true
    })
    expect(back[0]).toMatchObject({
      status: ShipmentStatus.RETURNED,
      rawStatus: '15',
      rawReason: 'devolucion'
    })
    const problem = await plugin.handleWebhook({
      guia: 'g',
      codigo: 16,
      fecha: '2026-12-02 10:00:00',
      razon: { codigo: '115', descripcion: 'Direccion incompleta/no contesta' }
    })
    expect(problem[0]).toMatchObject({
      status: ShipmentStatus.FAILED_ATTEMPT,
      rawStatus: '16',
      rawReason: '115'
    })
    expect(problem[0]?.description).toContain('Direccion incompleta')
  })

  it('has no events for what is not a status', async () => {
    await expect(plugin.handleWebhook(null)).resolves.toEqual([])
    await expect(
      plugin.handleWebhook({ guia: 'g', codigo: '13', fecha: 'later' })
    ).resolves.toEqual([])
  })

  it('knows its own webhook by the header and by nothing else', () => {
    const ok = { 'X-Webhook-Secret': C807_FAKE_WEBHOOK_SECRET }
    expect(plugin.validateWebhookSignature('{}', ok, C807_FAKE_WEBHOOK_SECRET)).toBe(true)
    expect(plugin.validateWebhookSignature('{}', {}, C807_FAKE_WEBHOOK_SECRET)).toBe(false)
    expect(
      plugin.validateWebhookSignature(
        '{}',
        { 'x-webhook-secret': 'short' },
        C807_FAKE_WEBHOOK_SECRET
      )
    ).toBe(false)
    expect(plugin.validateWebhookSignature('{}', { 'x-webhook-secret': '' }, '')).toBe(false)
  })
})

describe('C807: places', () => {
  it('lists the departments, and the municipalities of one, as the carrier numbers them', async () => {
    expect(await plugin.lookupLocations(context, {})).toEqual([
      { id: '2', name: 'Ahuachapan' },
      { id: '3', name: 'Cabanas' }
    ])
    expect(await plugin.lookupLocations(context, { parentId: '2' })).toEqual([
      { id: '2', name: 'AHUACHAPAN', parentId: '2' },
      { id: '4', name: 'ATIQUIZAYA', parentId: '2' }
    ])
    expect(await plugin.lookupLocations(context, { parentId: '2', search: 'atiq' })).toHaveLength(1)
  })
})
