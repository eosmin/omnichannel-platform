import {
  CarrierCapability,
  GuideRefundStatus,
  LabelFormat,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import {
  CarrierAuthError,
  type CarrierContext,
  CarrierRejectedError,
  CarrierUnavailableError,
  type CreateShipmentParams
} from '@platform/plugins/sdk'

import { createForzaCarrierPlugin } from './forza-carrier.plugin'
import { FORZA_STATUS_CATALOG } from './forza-constants'
import { signForzaRequest } from './forza-signing'

// Every value here is made up: no real credential, account or guide of anyone
const FAKE_SECRET = 'fake-secret-key-0123456789abcdef'
const FAKE_COD_APP = 'FAKE-COD-APP'
const FAKE_ACCOUNT = '000000000000'
const BASE_URL = 'https://forza.example.test:40467'

const context = (overrides: Record<string, unknown> = {}): CarrierContext => ({
  storeId: 'store-1',
  connectionId: 'connection-1',
  credentials: { codApp: FAKE_COD_APP, secretKey: FAKE_SECRET, bankAccountId: FAKE_ACCOUNT },
  metadata: {
    idClient: 1,
    country: 'GT',
    baseUrl: BASE_URL,
    codeOfReference: 111,
    originHeaderCodeTownship: '0101',
    bankId: '33',
    bankAccountName: 'FAKE HOLDER',
    bankAccountType: 'MONETARIA',
    ...overrides
  }
})

const createParams = (overrides: Partial<CreateShipmentParams> = {}): CreateShipmentParams => ({
  reference: 'ORD-1001',
  idempotencyKey: 'shipment:o:w:1',
  sender: {
    name: 'Fake Store',
    address: { line1: '1 Fake St', city: 'Guatemala', country: 'GT' },
    phone: '22223333'
  },
  recipient: {
    name: 'Fake Customer',
    phones: ['55550001', '55550002'],
    address: { line1: '5 Fake Ave', line2: 'House 3', city: 'Mixco', country: 'GT' },
    locationIds: { departmentId: '04', municipalityId: '0401' }
  },
  packageCount: 2,
  parcels: [{ weightGrams: 907 }, {}],
  serviceCode: 'home',
  shippingPayer: ShippingPayer.SENDER,
  cod: { amountCents: 42001, currency: 'GTQ' },
  labelFormat: LabelFormat.PDF_100X150,
  ...overrides
})

const answer = (body: Record<string, unknown>, status = 200): Response =>
  new Response(
    JSON.stringify({
      CodApp: FAKE_COD_APP,
      PayLoad: Buffer.from(JSON.stringify(body)).toString('base64')
    }),
    { status }
  )

const ok = (extra: Record<string, unknown>): Response =>
  answer({ StatusCode: 200, Description: 'Success', ...extra })

type Call = { url: string; init: RequestInit }
function plugin(respond: (call: Call, index: number) => Response | Promise<Response>): {
  plugin: ReturnType<typeof createForzaCarrierPlugin>
  calls: Call[]
} {
  const calls: Call[] = []
  const made = createForzaCarrierPlugin({
    fetch: (url, init) => {
      const call = { url, init: init ?? {} }
      calls.push(call)
      return Promise.resolve(respond(call, calls.length - 1))
    },
    now: () => new Date('2026-12-01T15:30:00Z')
  })
  return { plugin: made, calls }
}

// What was asked, read back from the call
function sent(call: Call): { method: string; params: Record<string, unknown>; signature: string } {
  const body = JSON.parse(call.init.body as string) as { CodApp: string; PayLoad: string }
  const request = JSON.parse(Buffer.from(body.PayLoad, 'base64').toString('utf8')) as {
    Method: string
    Params: Record<string, unknown>
  }
  const headers = call.init.headers as Record<string, string>
  return { method: request.Method, params: request.Params, signature: headers['LauValue'] ?? '' }
}

describe('forza carrier plugin', () => {
  describe('declaration', () => {
    it('declares only what the documentation confirms', () => {
      const { plugin: forza } = plugin(() => ok({}))
      expect([...forza.capabilities].sort()).toEqual(
        [
          CarrierCapability.CREATE_SHIPMENT,
          CarrierCapability.CANCEL_SHIPMENT,
          CarrierCapability.FETCH_STATUS,
          CarrierCapability.REQUIRES_LOCATION_IDS,
          CarrierCapability.PICKUP_REQUEST,
          CarrierCapability.COD
        ].sort()
      )
      for (const unconfirmed of [
        CarrierCapability.WEBHOOK_STATUS,
        CarrierCapability.PICKUP_MODIFY,
        CarrierCapability.PICKUP_CANCEL,
        CarrierCapability.RETURN_SHIPMENT,
        CarrierCapability.IDEMPOTENT_CREATE
      ]) {
        expect(forza.capabilities).not.toContain(unconfirmed)
      }
      expect(Reflect.get(forza, 'handleWebhook')).toBeUndefined()
      expect(Reflect.get(forza, 'cancelPickup')).toBeUndefined()
    })

    it('maps conservatively: nothing but explained ids, and null where the meaning is not settled', () => {
      const byCode = new Map(FORZA_STATUS_CATALOG.map(s => [s.code, s.defaultStatus]))
      expect(byCode.get('5')).toBe(ShipmentStatus.DELIVERED)
      expect(byCode.get('45')).toBe(ShipmentStatus.FAILED_ATTEMPT)
      expect(byCode.get('14')).toBe(ShipmentStatus.RETURNED)
      expect(byCode.get('22')).toBeNull()
      expect(byCode.get('25')).toBeNull()
      expect(byCode.has('3')).toBe(false)
    })
  })

  describe('connect and health', () => {
    it('tries the credentials with a catalog read and keeps the secrets apart from the settings', async () => {
      const { plugin: forza, calls } = plugin(() => ok({ ObjectValue: { provinceLists: [] } }))
      const result = await forza.connect({
        storeId: 'store-1',
        credentials: {
          codApp: FAKE_COD_APP,
          secretKey: FAKE_SECRET,
          idClient: '1',
          country: 'GT',
          baseUrl: BASE_URL,
          codeOfReference: '111',
          originHeaderCodeTownship: '0101',
          bankId: ''
        }
      })
      expect(sent(calls[0] as Call).method).toBe('GetListProvincesByHeaderCode')
      expect(result.credentials).toEqual({ codApp: FAKE_COD_APP, secretKey: FAKE_SECRET })
      expect(JSON.stringify(result.metadata)).not.toContain(FAKE_SECRET)
      expect(result.metadata).toMatchObject({ country: 'GT', idClient: 1, codeOfReference: 111 })
      expect(result.displayName).toBe('Forza GT')
    })

    it('refuses data that is not valid and a base URL that is not https, without a call', async () => {
      const { plugin: forza, calls } = plugin(() => ok({}))
      const base = {
        codApp: FAKE_COD_APP,
        secretKey: FAKE_SECRET,
        idClient: 1,
        country: 'GT',
        codeOfReference: 1,
        originHeaderCodeTownship: '0101'
      }
      await expect(
        forza.connect({
          storeId: 's',
          credentials: { ...base, baseUrl: 'http://forza.example.test' }
        })
      ).rejects.toBeInstanceOf(CarrierRejectedError)
      await expect(forza.connect({ storeId: 's', credentials: {} })).rejects.toBeInstanceOf(
        CarrierRejectedError
      )
      expect(calls).toHaveLength(0)
    })

    it('does not keep a connection whose credentials Forza rejects', async () => {
      const { plugin: forza } = plugin(() =>
        answer({ StatusCode: 401, Description: 'Unauthorized - No autorizado. LauValue inválido.' })
      )
      await expect(
        forza.connect({
          storeId: 's',
          credentials: {
            codApp: FAKE_COD_APP,
            secretKey: FAKE_SECRET,
            idClient: 1,
            country: 'GT',
            baseUrl: BASE_URL,
            codeOfReference: 1,
            originHeaderCodeTownship: '0101'
          }
        })
      ).rejects.toBeInstanceOf(CarrierAuthError)
    })

    it('reports health without any credential in it', async () => {
      const healthy = plugin(() => ok({ ObjectValue: { provinceLists: [] } })).plugin
      expect((await healthy.healthCheck(context())).healthy).toBe(true)
      const refused = plugin(() =>
        answer({ StatusCode: 401, Description: 'Unauthorized - No autorizado. CodApp inválido' })
      ).plugin
      const health = await refused.healthCheck(context())
      expect(health.healthy).toBe(false)
      expect(JSON.stringify(health)).not.toContain(FAKE_SECRET)
      expect(JSON.stringify(health)).not.toContain(FAKE_COD_APP)
      const incomplete = await healthy.healthCheck({ ...context(), credentials: {} })
      expect(incomplete.healthy).toBe(false)
    })
  })

  describe('createShipment', () => {
    const created = (): Response =>
      ok({ ObjectValue: [{ TrackingNumber: 'FD10000001', PDF: [`${BASE_URL}/Guia?id=x`] }] })

    it('sends a signed home-delivery guide with cash on delivery and answers the guide number', async () => {
      const { plugin: forza, calls } = plugin(created)
      const params = createParams()
      const result = await forza.createShipment?.(context(), params)
      expect(result?.guideNumber).toBe('FD10000001')
      expect(result?.label).toBeUndefined()
      const call = calls[0] as Call
      expect(call.url).toBe(`${BASE_URL}/Ecommerce/GetServiceByHeaderCodeRequest`)
      const request = sent(call)
      expect(request.signature).toBe(
        signForzaRequest(request.method, request.params, FAKE_SECRET).signature
      )
      expect(JSON.parse(call.init.body as string)).toMatchObject({ CodApp: FAKE_COD_APP })
      expect(request.params).toMatchObject({
        // 15:30 UTC is 09:30 in Central America
        DateOfSale: '2026-12-01 09:30:00',
        IdCountry: 'GT',
        CodeOfReference: '111',
        CountPieces: 2,
        Currency: 'GTQ',
        Collected: false,
        Ticket_Number: 'ORD1001',
        idDeliveryOption: '1',
        to_address: {
          name: 'Fake Customer',
          // The first phone only: a second field is not in the documentation
          phone: '55550001',
          HeaderCodeTownship: '0401',
          address1: '5 Fake Ave'
        },
        from_address: { HeaderCodeTownship: '0101' },
        COD: {
          CashOnDelivery: true,
          AmmountCashOnDelivery: '420.01',
          CashOnDeliveryCurrency: 'GTQ',
          BankId: '33',
          BankAccountId: FAKE_ACCOUNT
        }
      })
      const parcels = request.params['parcels'] as { weight: number; amount: string }[]
      expect(parcels).toHaveLength(2)
      expect(parcels[0]?.weight).toBe(2)
      expect(parcels[1]?.weight).toBe(1)
      expect(parcels.map(p => p.amount)).toEqual(['210.01', '210.00'])
      // What the core sent is the core's
      expect(params).toEqual(createParams())
    })

    it('charges the recipient when the recipient pays the shipping, and sends no bank data without cash on delivery', async () => {
      const { plugin: forza, calls } = plugin(created)
      await forza.createShipment?.(
        context(),
        createParams({ shippingPayer: ShippingPayer.RECIPIENT, cod: null })
      )
      const params = sent(calls[0] as Call).params
      expect(params['Collected']).toBe(true)
      expect(params['COD']).toMatchObject({
        CashOnDelivery: false,
        AmmountCashOnDelivery: '0.00',
        BankId: '',
        BankAccountId: ''
      })
    })

    it('refuses before any call when the municipality, the phone or the bank are missing', async () => {
      const { plugin: forza, calls } = plugin(created)
      const noPlace = createParams({
        recipient: { ...createParams().recipient, locationIds: undefined }
      })
      await expect(forza.createShipment?.(context(), noPlace)).rejects.toBeInstanceOf(
        CarrierRejectedError
      )
      const noPhone = createParams({ recipient: { ...createParams().recipient, phones: [] } })
      await expect(forza.createShipment?.(context(), noPhone)).rejects.toBeInstanceOf(
        CarrierRejectedError
      )
      await expect(
        forza.createShipment?.(context({ bankId: undefined }), createParams())
      ).rejects.toBeInstanceOf(CarrierRejectedError)
      expect(calls).toHaveLength(0)
    })

    it('maps the controlled answers: a refusal is rejected, a conflict or a server fault is unknown', async () => {
      const refused = plugin(() => answer({ StatusCode: 412, Description: 'Bad parcel' })).plugin
      await expect(refused.createShipment?.(context(), createParams())).rejects.toThrow(
        'Bad parcel'
      )
      const conflict = plugin(() => answer({ StatusCode: 409, Description: 'try again' })).plugin
      await expect(conflict.createShipment?.(context(), createParams())).rejects.toBeInstanceOf(
        CarrierUnavailableError
      )
      const down = plugin(() => new Response('boom', { status: 502 })).plugin
      await expect(down.createShipment?.(context(), createParams())).rejects.toBeInstanceOf(
        CarrierUnavailableError
      )
      const offline = createForzaCarrierPlugin({ fetch: () => Promise.reject(new Error('net')) })
      await expect(offline.createShipment?.(context(), createParams())).rejects.toBeInstanceOf(
        CarrierUnavailableError
      )
    })

    it('treats an accepted call with no guide as an unknown outcome, never as a refusal', async () => {
      const { plugin: forza } = plugin(() => ok({ ObjectValue: [] }))
      await expect(forza.createShipment?.(context(), createParams())).rejects.toBeInstanceOf(
        CarrierUnavailableError
      )
    })

    it('does not leak a credential in an error', async () => {
      const { plugin: forza } = plugin(() => answer({ StatusCode: 412, Description: 'Bad' }))
      const error = await forza.createShipment?.(context(), createParams()).catch((e: Error) => e)
      expect(String((error as Error).message)).not.toContain(FAKE_SECRET)
    })
  })

  describe('cancelShipment', () => {
    const cancelParams = { reference: 'ORD-1', guideNumber: 'FD10000001', idempotencyKey: 'k' }

    it('splits the guide into series and number and reports the refund as pending', async () => {
      const { plugin: forza, calls } = plugin(() =>
        ok({
          ObjectValue: [
            { Result: [{ DescriptionResult: 'La anulaciòn de guías fue realizada exitosamente.' }] }
          ]
        })
      )
      const result = await forza.cancelShipment?.(context(), cancelParams)
      expect(result?.refundStatus).toBe(GuideRefundStatus.PENDING)
      expect(sent(calls[0] as Call).params).toEqual({
        IdClient: 1,
        CodApp: FAKE_COD_APP,
        Guides: [{ Serie: 'FD', Number: 10000001 }]
      })
    })

    it('takes any other answer as a refusal that keeps the reason', async () => {
      const { plugin: forza } = plugin(() =>
        ok({
          ObjectValue: [{ Result: [{ DescriptionResult: 'La guía no está en estado Solicitado' }] }]
        })
      )
      await expect(forza.cancelShipment?.(context(), cancelParams)).rejects.toThrow('Solicitado')
    })

    it('refuses a guide number that is not a Forza guide, without a call', async () => {
      const { plugin: forza, calls } = plugin(() => ok({}))
      await expect(
        forza.cancelShipment?.(context(), { ...cancelParams, guideNumber: 'abc' })
      ).rejects.toBeInstanceOf(CarrierRejectedError)
      expect(calls).toHaveLength(0)
    })
  })

  describe('fetchLabel', () => {
    const labelParams = {
      reference: 'ORD-1',
      guideNumber: 'FD10000001',
      format: LabelFormat.PDF_A6
    }
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])

    it('reprints the guide, follows the link on the host of the connection and sends no signature to it', async () => {
      const { plugin: forza, calls } = plugin((_call, index) =>
        index === 0 ? ok({ ObjectValue: [{ PDF: [`${BASE_URL}/Guia?id=x`] }] }) : new Response(pdf)
      )
      const label = await forza.fetchLabel?.(context(), labelParams)
      expect(label?.format).toBe(LabelFormat.PDF_A6)
      expect(label?.contentType).toBe('application/pdf')
      expect(Array.from(label?.data ?? [])).toEqual(Array.from(pdf))
      expect(sent(calls[0] as Call).params).toEqual({ GuideNumber: [{ Guides: 'FD10000001' }] })
      expect(calls[1]?.init.headers).toBeUndefined()
    })

    it('never follows a link to another host, nor accepts a file that is not a PDF', async () => {
      const elsewhere = plugin(() =>
        ok({ ObjectValue: [{ PDF: ['https://evil.example.test/x'] }] })
      )
      await expect(elsewhere.plugin.fetchLabel?.(context(), labelParams)).rejects.toBeInstanceOf(
        CarrierRejectedError
      )
      expect(elsewhere.calls).toHaveLength(1)
      const notPdf = plugin((_c, index) =>
        index === 0
          ? ok({ ObjectValue: [{ PDF: [`${BASE_URL}/Guia?id=x`] }] })
          : new Response('<html>')
      )
      await expect(notPdf.plugin.fetchLabel?.(context(), labelParams)).rejects.toBeInstanceOf(
        CarrierRejectedError
      )
    })
  })

  describe('fetchStatus', () => {
    const track = ok({
      TrackOrder: {
        GuideSerie: 'FD',
        GuideNumber: 10000001,
        OrderDetail: {
          milestones: [
            { eventId: 1, stageId: 1, date: '2026-12-01 09:13:41Z', title: 'Solicitado' },
            { eventId: 7, stageId: 5, date: '2026-12-02 10:00:00Z', title: 'Entregado' },
            { eventId: 8, stageId: 99, date: '2026-12-02 11:00:00Z', title: 'Algo nuevo' },
            { eventId: 9, stageId: 5, date: 'not a date', title: 'Broken' }
          ]
        }
      }
    })

    it('reads the history of each guide, maps what the catalog explains and leaves the rest unmapped', async () => {
      const { plugin: forza, calls } = plugin(() => track)
      const events = await forza.fetchStatus?.(context(), [
        { reference: 'ORD-1', guideNumber: 'FD10000001' },
        { reference: 'ORD-2' }
      ])
      expect(calls).toHaveLength(1)
      expect(sent(calls[0] as Call).params).toEqual({ GuideSerie: 'FD', GuideNumber: 10000001 })
      expect(events?.map(e => [e.rawStatus, e.status, e.providerEventId])).toEqual([
        ['1', null, 'FD10000001:1:1:2026-12-01T09:13:41.000Z'],
        ['5', ShipmentStatus.DELIVERED, 'FD10000001:7:5:2026-12-02T10:00:00.000Z'],
        ['99', null, 'FD10000001:8:99:2026-12-02T11:00:00.000Z']
      ])
      expect(events?.[1]).toMatchObject({
        occurredAt: '2026-12-02T10:00:00.000Z',
        guideNumber: 'FD10000001'
      })
    })
  })

  describe('lookupLocations', () => {
    it('lists the departments of the country and filters them by text', async () => {
      const { plugin: forza, calls } = plugin(() =>
        ok({
          ObjectValue: {
            provinceLists: [
              { HeaderCode: '01', ProvinceName: 'Guatemala' },
              { HeaderCode: '02', ProvinceName: 'El Progreso' }
            ]
          }
        })
      )
      expect(await forza.lookupLocations?.(context(), {})).toHaveLength(2)
      expect(await forza.lookupLocations?.(context(), { search: 'prog' })).toEqual([
        { id: '02', name: 'El Progreso' }
      ])
      expect(sent(calls[0] as Call).params).toEqual({ HeaderCode: '-1', IdCountry: 'GT' })
    })

    it('lists the municipalities of one department with the code a guide needs as their id', async () => {
      const { plugin: forza, calls } = plugin(() =>
        ok({
          ObjectValue: {
            TownshipByHeaderCodes: [
              { HeaderCode: '04', HeaderCodeTownship: '0401', TownshipName: 'Chimaltenango' },
              { HeaderCode: '05', HeaderCodeTownship: '0501', TownshipName: 'Other department' }
            ]
          }
        })
      )
      expect(await forza.lookupLocations?.(context(), { parentId: '04' })).toEqual([
        { id: '0401', name: 'Chimaltenango', parentId: '04' }
      ])
      expect(sent(calls[0] as Call).params).toEqual({
        HeaderCodeTownship: '-1',
        HeaderCode: '04',
        IdCountry: 'GT'
      })
    })
  })

  describe('requestPickup', () => {
    const pickupParams = {
      idempotencyKey: 'k',
      window: { date: '2026-12-02', from: '09:00', to: '12:00' },
      packageCount: 3
    }

    it('asks for the pickup at the visit point and answers the service id', async () => {
      const { plugin: forza, calls } = plugin(() =>
        ok({ ObjectValue: { IdResult: 200, Message: 'ok', ServiceId: 777 } })
      )
      const result = await forza.requestPickup?.(context({ pickupVehicleTypeId: 2 }), pickupParams)
      expect(result).toEqual({ pickupRef: '777', window: pickupParams.window, packageCount: 3 })
      expect(sent(calls[0] as Call).params).toEqual({
        CodeOfReference: 111,
        StartDate: '2026-12-02 09:00:00',
        EndDate: '2026-12-02 12:00:00',
        QuantityOfPieces: 3,
        TypeVehicleId: 2
      })
    })

    it('takes a business refusal inside a valid answer (one pickup a day, after 17:00) as a rejection', async () => {
      const { plugin: forza } = plugin(() =>
        ok({
          ObjectValue: { IdResult: 409, Message: 'Ya fue solicitado un servicio hoy', ServiceId: 5 }
        })
      )
      await expect(forza.requestPickup?.(context(), pickupParams)).rejects.toThrow(
        'Ya fue solicitado'
      )
    })
  })

  describe('review findings', () => {
    it('does not take a refusal that mentions success as a done cancellation', async () => {
      const { plugin: forza } = plugin(() =>
        ok({
          ObjectValue: [
            { Result: [{ DescriptionResult: 'La guía no pudo ser cancelada exitosamente' }] }
          ]
        })
      )
      await expect(
        forza.cancelShipment?.(context(), {
          reference: 'o',
          guideNumber: 'FD1',
          idempotencyKey: 'k'
        })
      ).rejects.toBeInstanceOf(CarrierRejectedError)
    })

    it('refuses before any call an amount in another currency, a fractional amount and a negative one', async () => {
      const { plugin: forza, calls } = plugin(() => ok({}))
      for (const cod of [
        { amountCents: 10000, currency: 'USD' },
        { amountCents: 100.5, currency: 'GTQ' },
        { amountCents: -1, currency: 'GTQ' },
        { amountCents: 0, currency: 'GTQ' }
      ]) {
        await expect(
          forza.createShipment?.(context(), createParams({ cod }))
        ).rejects.toBeInstanceOf(CarrierRejectedError)
      }
      expect(calls).toHaveLength(0)
    })

    it('does not keep a connection with part of the bank data, nor one that points at an internal host', async () => {
      const { plugin: forza, calls } = plugin(() => ok({}))
      const base = {
        codApp: FAKE_COD_APP,
        secretKey: FAKE_SECRET,
        idClient: 1,
        country: 'GT',
        baseUrl: BASE_URL,
        codeOfReference: 1,
        originHeaderCodeTownship: '0101'
      }
      await expect(
        forza.connect({ storeId: 's', credentials: { ...base, bankId: '33' } })
      ).rejects.toBeInstanceOf(CarrierRejectedError)
      for (const baseUrl of [
        'https://localhost:40467',
        'https://localhost.:40467',
        'https://forza.internal.',
        'https://100.64.0.1',
        'https://192.168.1.5',
        'https://169.254.169.254',
        'https://intranet',
        'https://forza.internal'
      ]) {
        await expect(
          forza.connect({ storeId: 's', credentials: { ...base, baseUrl } })
        ).rejects.toBeInstanceOf(CarrierRejectedError)
      }
      expect(calls).toHaveLength(0)
    })

    it('takes a throttle as unknown, not as a refusal, and a malformed-body 401 as a refusal', async () => {
      const throttled = plugin(() => new Response('slow down', { status: 429 })).plugin
      await expect(throttled.createShipment?.(context(), createParams())).rejects.toBeInstanceOf(
        CarrierUnavailableError
      )
      const malformed = plugin(() =>
        answer({
          StatusCode: 401,
          Description: 'Body Message incorrecto, Se espera valor del parametro CodApp requerido'
        })
      ).plugin
      await expect(malformed.createShipment?.(context(), createParams())).rejects.toBeInstanceOf(
        CarrierRejectedError
      )
    })

    it('does not show the body of an answer that is not the PayLoad', async () => {
      const { plugin: forza } = plugin(
        () => new Response('<html>echo secret-body-text</html>', { status: 400 })
      )
      const error = await forza.createShipment?.(context(), createParams()).catch((e: Error) => e)
      expect((error as Error).message).not.toContain('secret-body-text')
    })

    it('goes on with the other guides when Forza refuses one, and stops when it cannot be reached', async () => {
      const { plugin: forza } = plugin((call, index) =>
        index === 0
          ? answer({ StatusCode: 412, Description: 'unknown guide' })
          : ok({
              TrackOrder: {
                OrderDetail: {
                  milestones: [
                    { eventId: 1, stageId: 5, date: '2026-12-02 10:00:00Z', title: 'Entregado' }
                  ]
                }
              }
            })
      )
      const events = await forza.fetchStatus?.(context(), [
        { reference: 'a', guideNumber: 'FD1' },
        { reference: 'b', guideNumber: 'FD2' },
        { reference: 'c', guideNumber: 'not a guide' }
      ])
      expect(events?.map(e => e.guideNumber)).toEqual(['FD2'])
      const down = plugin(() => new Response('x', { status: 503 })).plugin
      await expect(
        down.fetchStatus?.(context(), [{ reference: 'a', guideNumber: 'FD1' }])
      ).rejects.toBeInstanceOf(CarrierUnavailableError)
    })

    it('reads a date with no zone as UTC and keeps the guide in capitals', async () => {
      const { plugin: forza } = plugin(() =>
        ok({
          TrackOrder: {
            OrderDetail: { milestones: [{ eventId: 1, stageId: 2, date: '2026-12-02 10:00:00' }] }
          }
        })
      )
      const events = await forza.fetchStatus?.(context(), [{ reference: 'a', guideNumber: 'fd1' }])
      expect(events?.[0]).toMatchObject({
        occurredAt: '2026-12-02T10:00:00.000Z',
        guideNumber: 'FD1'
      })
    })

    it('refuses a label that announces more than the limit', async () => {
      const { plugin: forza } = plugin((_call, index) =>
        index === 0
          ? ok({ ObjectValue: [{ PDF: [`${BASE_URL}/Guia?id=x`] }] })
          : new Response('%PDF', { headers: { 'content-length': String(50 * 1024 * 1024) } })
      )
      await expect(
        forza.fetchLabel?.(context(), {
          reference: 'a',
          guideNumber: 'FD1',
          format: LabelFormat.PDF_A6
        })
      ).rejects.toBeInstanceOf(CarrierRejectedError)
    })

    it('keeps a guide cancelled whose text carries "No." and refuses an answer with more than one guide', async () => {
      const done = plugin(() =>
        ok({
          ObjectValue: [
            { Result: [{ DescriptionResult: 'La anulaciòn de guías fue realizada exitosamente.' }] }
          ]
        })
      ).plugin
      await expect(
        done.cancelShipment?.(context(), {
          reference: 'o',
          guideNumber: 'FD1',
          idempotencyKey: 'k'
        })
      ).resolves.toBeDefined()
      const many = plugin(() =>
        ok({ ObjectValue: [{ TrackingNumber: 'FD1' }, { TrackingNumber: 'FD2' }] })
      ).plugin
      await expect(many.createShipment?.(context(), createParams())).rejects.toBeInstanceOf(
        CarrierUnavailableError
      )
    })

    it('takes a 401 with no PayLoad as bad credentials, even in a poll', async () => {
      const { plugin: forza } = plugin(() => new Response('denied', { status: 401 }))
      await expect(
        forza.fetchStatus?.(context(), [{ reference: 'a', guideNumber: 'FD1' }])
      ).rejects.toBeInstanceOf(CarrierAuthError)
    })

    it('stops reading a label that passes the limit without announcing it', async () => {
      const big = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024))
        }
      })
      const { plugin: forza } = plugin((_call, index) =>
        index === 0 ? ok({ ObjectValue: [{ PDF: [`${BASE_URL}/Guia?id=x`] }] }) : new Response(big)
      )
      await expect(
        forza.fetchLabel?.(context(), {
          reference: 'a',
          guideNumber: 'FD1',
          format: LabelFormat.PDF_A6
        })
      ).rejects.toBeInstanceOf(CarrierRejectedError)
    })
  })
})
