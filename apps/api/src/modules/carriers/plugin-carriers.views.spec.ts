import type { CarrierConnectionView, CarrierRegistryEntry } from './carrier-connections.views'
import {
  pluginCarrierConnection,
  pluginCarrierRegistryEntry,
  pluginStatusCatalogEntry,
  pluginUnmappedStatus
} from './plugin-carriers.views'

const connection = (): CarrierConnectionView => ({
  id: 'c-1',
  carrierId: 'carrier-x',
  carrierName: 'Carrier X',
  displayName: 'Main courier',
  status: 'ACTIVE',
  hasCredentials: true,
  hasWebhookSecret: true,
  webhookUrl: 'https://api.example.invalid/hooks/secret-path',
  capabilities: [],
  isDefault: true,
  defaultServiceCode: 'standard',
  defaultShippingPayer: 'SENDER',
  labelFormat: 'PDF',
  contact: { phone: '70000000' },
  guidePrefix: 'GX',
  services: [{ code: 'standard', label: 'Standard', active: true }],
  pickupEnabled: true,
  pickupDays: [1, 2],
  pickupCutoffTime: '15:00',
  autoPickup: false,
  autoPickupTime: null,
  pickupReminderMinutes: 30,
  pollIntervalMinutes: 60,
  maxDeliveryAttempts: 3,
  defaultShippingFeeCents: 500,
  minShippingFeeCents: 100,
  maxShippingFeeCents: 900,
  remittanceDeductsFee: true,
  commissionBps: 250,
  serviceRatesCents: { standard: 777 },
  openShipments: 2,
  openPickups: 1,
  lastHealthyAt: null,
  lastError: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z'
})

describe('the carrier connections a plugin reads', () => {
  it('leaves out every secret, contact and agreed amount, by name', () => {
    const view = pluginCarrierConnection(connection())
    const text = JSON.stringify(view)

    for (const key of [
      'hasCredentials',
      'hasWebhookSecret',
      'webhookUrl',
      'contact',
      'guidePrefix',
      'defaultShippingFeeCents',
      'minShippingFeeCents',
      'maxShippingFeeCents',
      'remittanceDeductsFee',
      'commissionBps',
      'serviceRatesCents'
    ]) {
      expect(key in view).toBe(false)
    }
    expect(text).not.toMatch(/secret-path|70000000|777/)
  })

  it('keeps what a plugin needs to choose a carrier and follow it', () => {
    expect(pluginCarrierConnection(connection())).toMatchObject({
      id: 'c-1',
      carrierId: 'carrier-x',
      displayName: 'Main courier',
      services: [{ code: 'standard', label: 'Standard', active: true }],
      pickupEnabled: true,
      openShipments: 2
    })
  })

  it('names the fields one by one, so a new column does not reach a plugin', () => {
    const extra = { ...connection(), credentials: 'ciphertext-of-the-credentials' }

    expect(JSON.stringify(pluginCarrierConnection(extra))).not.toContain('ciphertext')
    expect(Object.keys(pluginCarrierConnection(extra)).sort()).toEqual(
      Object.keys(pluginCarrierConnection(connection())).sort()
    )
  })

  it('answers the catalog without the form that asks for credentials nor the fees', () => {
    const entry: CarrierRegistryEntry = {
      id: 'carrier-x',
      name: 'Carrier X',
      version: '1.0.0',
      capabilities: [],
      shipmentCreation: 'API',
      maxBatchSize: null,
      hasCredentials: true,
      services: [{ code: 'standard', label: 'Standard' }],
      connectFields: [
        {
          key: 'apiToken',
          labelKey: 'x',
          label: null,
          helpKey: null,
          secret: true,
          required: true,
          multiple: false
        }
      ],
      feeSettings: { commission: true, rateServices: [{ code: 'standard', labelKey: 'y' }] }
    }

    const view = pluginCarrierRegistryEntry(entry)

    expect(view).toMatchObject({ id: 'carrier-x', services: [{ code: 'standard' }] })
    expect(JSON.stringify(view)).not.toMatch(/apiToken|connectFields|feeSettings|hasCredentials/)
  })
})

describe('the statuses of a carrier a plugin reads', () => {
  it('does not answer the raw text the carrier wrote for an unmapped status', () => {
    const view = pluginUnmappedStatus({
      providerCode: 'X1',
      sampleRawStatus: 'invalid phone 70000000 for Ana',
      occurrences: 3,
      shipmentsWaiting: 2,
      firstSeenAt: '2026-11-14T00:00:00.000Z',
      lastSeenAt: '2026-11-15T00:00:00.000Z'
    })

    expect('sampleRawStatus' in view).toBe(false)
    expect(JSON.stringify(view)).not.toMatch(/70000000|Ana/)
    expect(view).toMatchObject({ providerCode: 'X1', occurrences: 3, shipmentsWaiting: 2 })
  })

  it('names the fields of the catalog one by one', () => {
    const entry = {
      providerCode: 'X1',
      label: 'In transit',
      defaultStatus: null,
      hasMapping: true,
      mappedStatus: 'IN_TRANSIT',
      source: 'OWNER',
      mappedBy: 'user-staff-1'
    }

    expect(Object.keys(pluginStatusCatalogEntry(entry)).sort()).toEqual([
      'defaultStatus',
      'hasMapping',
      'label',
      'mappedStatus',
      'providerCode',
      'source'
    ])
  })
})
