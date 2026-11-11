import { CarrierCapability, CarrierId, LabelFormat, LabelPageSizesMm } from '@platform/core/domain'
import {
  CarrierRejectedError,
  LabelElementKinds,
  type LabelInput,
  LabelPaymentKinds,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import { localCarrierPlugin, LOCAL_DEFAULT_SERVICE_CODE } from './local-carrier.plugin'

describe('localCarrierPlugin', () => {
  it('is the internal carrier: it makes no guide through the plugin and has no API', () => {
    expect(localCarrierPlugin.id).toBe(CarrierId.LOCAL)
    expect(localCarrierPlugin.shipmentCreation).toBe(ShipmentCreationModes.INTERNAL)
    expect(localCarrierPlugin.capabilities).toEqual([
      CarrierCapability.INTERNAL_GUIDE,
      CarrierCapability.COD
    ])
    for (const method of [
      'createShipment',
      'createShipmentsWithPickup',
      'cancelShipment',
      'fetchStatus',
      'handleWebhook',
      'validateWebhookSignature',
      'requestPickup'
    ] as const) {
      expect(localCarrierPlugin).not.toHaveProperty(method)
    }
  })

  it('has an empty status catalog: its statuses are set by hand', () => {
    expect(localCarrierPlugin.statusCatalog()).toEqual([])
  })

  it('has one service', () => {
    expect(localCarrierPlugin.serviceCatalog().map(s => s.code)).toEqual([
      LOCAL_DEFAULT_SERVICE_CODE
    ])
  })

  describe('connect', () => {
    const connect = (credentials: Record<string, unknown>) =>
      localCarrierPlugin.connect({ storeId: 'store-1', credentials })

    it('names the connection after the courier and keeps the data, with no credential', async () => {
      await expect(
        connect({ name: ' Juan Moto ', phone: '71234567', notes: 'Mornings only', prefix: 'JM' })
      ).resolves.toEqual({
        displayName: 'Juan Moto',
        credentials: {},
        metadata: { phone: '71234567', prefix: 'JM', notes: 'Mornings only' }
      })
    })

    it('does not need notes', async () => {
      const result = await connect({ name: 'Juan', phone: '71234567', prefix: 'J1' })
      expect(result.metadata).toEqual({ phone: '71234567', prefix: 'J1' })
    })

    it.each([
      ['no name', { phone: '71234567', prefix: 'JM' }],
      ['no phone', { name: 'Juan', prefix: 'JM' }],
      ['no prefix', { name: 'Juan', phone: '71234567' }],
      ['a lowercase prefix', { name: 'Juan', phone: '71234567', prefix: 'jm' }],
      ['a prefix with a dash', { name: 'Juan', phone: '71234567', prefix: 'J-M' }],
      ['a prefix over six characters', { name: 'Juan', phone: '71234567', prefix: 'ABCDEFG' }],
      ['an empty prefix', { name: 'Juan', phone: '71234567', prefix: '' }]
    ])('refuses %s', async (_label, credentials) => {
      await expect(connect(credentials)).rejects.toBeInstanceOf(CarrierRejectedError)
    })
  })

  it('is always healthy: there is nothing to reach', async () => {
    const health = await localCarrierPlugin.healthCheck({
      storeId: 's',
      connectionId: 'c',
      credentials: {},
      metadata: {}
    })
    expect(health.healthy).toBe(true)
  })
})

describe('the label the plugin draws', () => {
  const texts = {
    from: 'From',
    to: 'To',
    collect: 'Collect',
    paid: 'PAID',
    order: 'Order',
    packages: 'Packages',
    service: 'Service',
    notes: 'Notes'
  }
  const input = (payment: LabelInput['payment']): LabelInput => ({
    format: LabelFormat.PDF_A6,
    guideNumber: 'JM-000123',
    orderNumber: 'ORD-1',
    sender: { name: 'Warehouse', addressLines: ['1 Rd'] },
    recipient: { name: 'Ana', phones: ['71234567'], addressLines: ['5 St'] },
    packageCount: 1,
    serviceLabel: 'Local',
    payment,
    texts
  })

  it('is on the page of the format asked and carries the COD amount', () => {
    const layout = localCarrierPlugin.buildLabelLayout?.(
      input({ kind: LabelPaymentKinds.COD, amountText: '$45.50' })
    )
    expect([layout?.format, layout?.widthMm, layout?.heightMm]).toEqual([
      LabelFormat.PDF_A6,
      LabelPageSizesMm[LabelFormat.PDF_A6].widthMm,
      LabelPageSizesMm[LabelFormat.PDF_A6].heightMm
    ])
    const lines = (layout?.elements ?? []).flatMap(e =>
      e.kind === LabelElementKinds.TEXT ? e.lines : []
    )
    expect(lines).toContain('$45.50')
  })

  it('says PAID for a prepaid shipment', () => {
    const layout = localCarrierPlugin.buildLabelLayout?.(input({ kind: LabelPaymentKinds.PAID }))
    const lines = (layout?.elements ?? []).flatMap(e =>
      e.kind === LabelElementKinds.TEXT ? e.lines : []
    )
    expect(lines).toContain('PAID')
  })
})

describe('localConnectionSchema notes', () => {
  it('drops notes that are only blanks', async () => {
    const result = await localCarrierPlugin.connect({
      storeId: 's',
      credentials: { name: 'Juan', phone: '71234567', prefix: 'JM', notes: '   ' }
    })
    expect(result.metadata).toEqual({ phone: '71234567', prefix: 'JM' })
  })
})
