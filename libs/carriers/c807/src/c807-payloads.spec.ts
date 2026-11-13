import { ShippingPayer } from '@platform/core/domain'
import { type CreateShipmentParams } from '@platform/plugins/sdk'

import {
  c807Amount,
  c807ServiceTypeOf,
  toC807Guide as buildGuide,
  toC807Request
} from './c807-payloads'

const LB = { weightUnit: 'LB' } as const
const toC807Guide = (
  params: CreateShipmentParams,
  settings: { fallbackEmail?: string; weightUnit: 'LB' | 'KG' } = LB
): Record<string, unknown> => buildGuide(params, settings)

const params = (overrides: Partial<CreateShipmentParams> = {}): CreateShipmentParams => ({
  reference: 'ORD-1001',
  idempotencyKey: 'key',
  sender: {
    name: 'Warehouse',
    address: { line1: '1 Rd', city: 'City', country: 'SV' },
    phone: '22223333'
  },
  recipient: {
    name: 'Ana',
    phones: ['71234567', '72345678'],
    email: 'ana@example.com',
    address: { line1: '5 Street', line2: 'Apt 2', city: 'City', country: 'SV' },
    locationIds: { departmentId: '2', municipalityId: '4' }
  },
  packageCount: 1,
  parcels: [{ weightGrams: 2500 }],
  serviceCode: 'standard',
  shippingPayer: ShippingPayer.SENDER,
  cod: null,
  labelFormat: 'pdf_100x150',
  ...overrides
})

describe('the type of service of a guide', () => {
  it('collects the product with CCE when the order is cash on delivery', () => {
    expect(
      c807ServiceTypeOf({
        cod: { amountCents: 1000, currency: 'USD' },
        shippingPayer: ShippingPayer.SENDER
      })
    ).toBe('CCE')
  })

  it('makes the recipient pay the carrier with SEC when the product is already paid', () => {
    expect(c807ServiceTypeOf({ cod: null, shippingPayer: ShippingPayer.RECIPIENT })).toBe('SEC')
  })

  it('sends an order paid in full, with nothing to collect, as SER', () => {
    expect(c807ServiceTypeOf({ cod: null, shippingPayer: ShippingPayer.SENDER })).toBe('SER')
  })

  it('collects the product with CCE whoever pays the carrier: C807 takes its fee out of what it collects', () => {
    expect(
      c807ServiceTypeOf({
        cod: { amountCents: 1300, currency: 'USD' },
        shippingPayer: ShippingPayer.RECIPIENT
      })
    ).toBe('CCE')
  })
})

describe('the guide of a request', () => {
  it('writes the guide as the documentation asks', () => {
    expect(
      toC807Guide(params({ cod: { amountCents: 1050, currency: 'USD' }, notes: 'Ring twice' }))
    ).toEqual({
      orden: 'ORD-1001',
      nombre: 'Ana',
      direccion: '5 Street, Apt 2',
      telefono: '71234567 / 72345678',
      correo: 'ana@example.com',
      tipo_servicio: 'CCE',
      monto_cce: 10.5,
      departamento_id: 2,
      municipio_id: 4,
      indicaciones: 'Ring twice',
      detalle: [{ peso: 5.512, contenido: 'Pedido ORD-1001', unidad_medida: 'LB' }]
    })
  })

  it('sends the e-mail of the customer, the fallback of the connection when there is none, and refuses with neither', () => {
    const withoutEmail = params({ recipient: { ...params().recipient, email: undefined } })
    expect(
      toC807Guide(withoutEmail, { ...LB, fallbackEmail: 'tienda@example.com' })['correo']
    ).toBe('tienda@example.com')
    expect(() => toC807Guide(withoutEmail)).toThrow('e-mail')
    expect(toC807Guide(params(), { ...LB, fallbackEmail: 'tienda@example.com' })['correo']).toBe(
      'ana@example.com'
    )
  })

  it('uses the fallback when the e-mail of the customer is longer than C807 takes, and one unit when the weight is no number', () => {
    const long = params({
      recipient: { ...params().recipient, email: `${'a'.repeat(70)}@example.com` }
    })
    expect(toC807Guide(long, { ...LB, fallbackEmail: 'tienda@example.com' })['correo']).toBe(
      'tienda@example.com'
    )
    for (const weightGrams of [Number.NaN, -5, 0]) {
      expect(toC807Guide(params({ parcels: [{ weightGrams }] }))['detalle']).toEqual([
        expect.objectContaining({ peso: 1 })
      ])
    }
  })

  it('weighs in the unit of the connection', () => {
    const kilos = toC807Guide(params(), { weightUnit: 'KG' })
    expect(kilos['detalle']).toEqual([
      { peso: 2.5, contenido: 'Pedido ORD-1001', unidad_medida: 'KG' }
    ])
  })

  it('sends no amount for a guide that collects nothing', () => {
    expect(toC807Guide(params())).not.toHaveProperty('monto_cce')
  })

  it('numbers the packages of a guide that has several, one kilogram when none has a weight', () => {
    const guide = toC807Guide(params({ packageCount: 2, parcels: [] }))
    expect(guide['detalle']).toEqual([
      { peso: 1, contenido: 'Pedido ORD-1001', unidad_medida: 'LB', codigo: '1' },
      { peso: 1, contenido: 'Pedido ORD-1001', unidad_medida: 'LB', codigo: '2' }
    ])
  })

  it('refuses what C807 would refuse, saying which part', () => {
    expect(() => toC807Guide(params({ reference: 'X'.repeat(26) }))).toThrow('order number')
    expect(() =>
      toC807Guide(params({ recipient: { ...params().recipient, name: 'N'.repeat(76) } }))
    ).toThrow('name of the recipient')
    expect(() =>
      toC807Guide(params({ recipient: { ...params().recipient, locationIds: undefined } }))
    ).toThrow('delivery place')
    expect(() =>
      toC807Guide(
        params({
          recipient: {
            ...params().recipient,
            locationIds: { departmentId: 'x', municipalityId: '4' }
          }
        })
      )
    ).toThrow('department')
  })

  it('turns cents into the decimal of the carrier', () => {
    expect(c807Amount(1999)).toBe(19.99)
    expect(c807Amount(5)).toBe(0.05)
  })
})

describe('the request of a pickup', () => {
  it('joins the date and the time and leaves out what is not set', () => {
    expect(
      toC807Request({
        pickupDate: '2026-12-01',
        pickupFrom: '09:00',
        metadata: { deliveryType: 'NRML', environment: 'production', weightUnit: 'LB' },
        guides: []
      })
    ).toEqual({ recolecta_fecha: '2026-12-01 09:00', tipo_entrega: 'NRML', guias: [] })
    expect(
      toC807Request({
        pickupDate: '2026-12-01',
        pickupFrom: '09:00',
        metadata: { deliveryType: 'PLUS', environment: 'production', weightUnit: 'LB', site: 3 },
        guides: []
      })
    ).toMatchObject({ sede: 3, tipo_entrega: 'PLUS' })
  })
})
