import { ShippingPayer } from '@platform/core/domain'
import { CarrierRejectedError, type CreateShipmentParams } from '@platform/plugins/sdk'

import { c807Amount, c807ServiceTypeOf, toC807Guide, toC807Request } from './c807-payloads'

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

  it('refuses a product to collect together with a shipping the recipient pays, which C807 does not document', () => {
    expect(() =>
      c807ServiceTypeOf({
        cod: { amountCents: 1000, currency: 'USD' },
        shippingPayer: ShippingPayer.RECIPIENT
      })
    ).toThrow(CarrierRejectedError)
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
      tipo_servicio: 'CCE',
      monto_cce: 10.5,
      departamento_id: 2,
      municipio_id: 4,
      indicaciones: 'Ring twice',
      detalle: [{ peso: 2.5, contenido: 'Pedido ORD-1001', unidad_medida: 'KG' }]
    })
  })

  it('sends no amount for a guide that collects nothing', () => {
    expect(toC807Guide(params())).not.toHaveProperty('monto_cce')
  })

  it('numbers the packages of a guide that has several, one kilogram when none has a weight', () => {
    const guide = toC807Guide(params({ packageCount: 2, parcels: [] }))
    expect(guide['detalle']).toEqual([
      { peso: 1, contenido: 'Pedido ORD-1001', unidad_medida: 'KG', codigo: '1' },
      { peso: 1, contenido: 'Pedido ORD-1001', unidad_medida: 'KG', codigo: '2' }
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
        metadata: { deliveryType: 'NRML' },
        guides: []
      })
    ).toEqual({ recolecta_fecha: '2026-12-01 09:00', tipo_entrega: 'NRML', guias: [] })
    expect(
      toC807Request({
        pickupDate: '2026-12-01',
        pickupFrom: '09:00',
        metadata: { deliveryType: 'PLUS', site: 3 },
        guides: []
      })
    ).toMatchObject({ sede: 3, tipo_entrega: 'PLUS' })
  })
})
