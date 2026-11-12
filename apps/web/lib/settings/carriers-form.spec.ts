import type { CarrierConnectionView } from '@platform/api-client'

import {
  carrierRulesChanges,
  carrierRulesDraftOf,
  carrierRulesProblems,
  connectBody,
  connectProblems,
  EMPTY_CONNECT_DRAFT,
  hasInternalGuide,
  parseCredentials
} from './carriers-form'

const view: CarrierConnectionView = {
  id: 'c1',
  carrierId: 'x',
  carrierName: 'X',
  displayName: 'Main',
  status: 'active',
  hasCredentials: true,
  hasWebhookSecret: false,
  webhookUrl: null,
  capabilities: [],
  isDefault: false,
  defaultServiceCode: null,
  defaultShippingPayer: 'sender',
  labelFormat: 'pdf_100x150',
  contact: null,
  guidePrefix: null,
  services: [],
  pickupEnabled: true,
  pickupDays: [5, 1, 3],
  pickupCutoffTime: '15:00',
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

describe('carrier rules draft', () => {
  it('starts from the connection, with the days in order, and changes nothing', () => {
    const draft = carrierRulesDraftOf(view)
    expect(draft.pickupDays).toEqual([1, 3, 5])
    expect(carrierRulesProblems(draft)).toEqual([])
    expect(carrierRulesChanges(view, draft)).toEqual({})
  })

  it('sends only what changed', () => {
    const draft = {
      ...carrierRulesDraftOf(view),
      displayName: ' Forward ',
      pickupDays: [1, 2],
      pickupCutoffTime: '',
      pickupReminderMinutes: '45',
      isDefault: true
    }
    expect(carrierRulesChanges(view, draft)).toEqual({
      displayName: 'Forward',
      isDefault: true,
      pickupDays: [1, 2],
      pickupCutoffTime: null,
      pickupReminderMinutes: 45
    })
  })

  it('never turns the default flag off from here', () => {
    const draft = { ...carrierRulesDraftOf({ ...view, isDefault: true }), isDefault: false }
    expect(carrierRulesChanges({ ...view, isDefault: true }, draft)).toEqual({})
  })

  it('refuses what the table refuses', () => {
    const base = carrierRulesDraftOf(view)
    expect(carrierRulesProblems({ ...base, pickupDays: [] })).toEqual(['noDays'])
    expect(carrierRulesProblems({ ...base, pickupEnabled: false, autoPickup: true })).toEqual([
      'autoNeedsPickups',
      'autoTime'
    ])
    expect(carrierRulesProblems({ ...base, autoPickup: true, autoPickupTime: '' })).toEqual([
      'autoTime'
    ])
    expect(carrierRulesProblems({ ...base, pickupCutoffTime: '25:00' })).toEqual(['cutoff'])
    expect(carrierRulesProblems({ ...base, pickupReminderMinutes: '1e2' })).toEqual(['reminder'])
    expect(carrierRulesProblems({ ...base, pickupReminderMinutes: '99999' })).toEqual(['reminder'])
    expect(carrierRulesProblems({ ...base, displayName: '  ' })).toEqual(['name'])
    expect(carrierRulesProblems({ ...base, credentials: '[1]' })).toEqual(['credentials'])
  })

  it('sends new credentials only when typed', () => {
    const draft = { ...carrierRulesDraftOf(view), credentials: '{"apiKey":"k"}' }
    expect(carrierRulesChanges(view, draft)).toEqual({ credentials: { apiKey: 'k' } })
  })
})

describe('parseCredentials', () => {
  it('reads an object, nothing for empty, and refuses the rest', () => {
    expect(parseCredentials('{"a":1}')).toEqual({ a: 1 })
    expect(parseCredentials('  ')).toBeNull()
    expect(parseCredentials('[]')).toBeUndefined()
    expect(parseCredentials('"x"')).toBeUndefined()
    expect(parseCredentials('{')).toBeUndefined()
  })
})

describe('connect form', () => {
  const external = { capabilities: [], hasCredentials: true }
  const internal = { capabilities: ['internal_guide'], hasCredentials: false }

  it('needs a carrier', () => {
    expect(connectProblems(EMPTY_CONNECT_DRAFT, undefined)).toEqual(['carrier'])
  })

  it('asks an external carrier for its credentials', () => {
    const draft = { ...EMPTY_CONNECT_DRAFT, carrierId: 'x' }
    expect(connectProblems(draft, external)).toEqual(['credentials'])
    const ready = { ...draft, displayName: ' Mine ', credentials: '{"key":"v"}', isDefault: true }
    expect(connectProblems(ready, external)).toEqual([])
    expect(connectBody(ready, external)).toEqual({
      carrierId: 'x',
      displayName: 'Mine',
      isDefault: true,
      credentials: { key: 'v' }
    })
  })

  it('asks a courier the platform makes guides for its name, phone and prefix', () => {
    expect(hasInternalGuide(internal.capabilities)).toBe(true)
    const draft = { ...EMPTY_CONNECT_DRAFT, carrierId: 'l' }
    expect(connectProblems(draft, internal)).toEqual([
      'courierName',
      'courierPhone',
      'courierPrefix'
    ])
    const ready = {
      ...draft,
      courierName: ' Juan ',
      courierPhone: '555',
      courierPrefix: 'JM',
      courierNotes: ' '
    }
    expect(connectProblems(ready, internal)).toEqual([])
    expect(connectBody(ready, internal)).toEqual({
      carrierId: 'l',
      credentials: { name: 'Juan', phone: '555', prefix: 'JM' }
    })
    expect(connectProblems({ ...ready, courierPrefix: 'jm' }, internal)).toEqual(['courierPrefix'])
  })
})
