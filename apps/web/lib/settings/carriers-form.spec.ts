import type { CarrierConnectFieldView, CarrierConnectionView } from '@platform/api-client'

import {
  acceptsCashOnDelivery,
  canPoll,
  carrierRulesChanges,
  carrierRulesDraftOf,
  carrierRulesProblems,
  credentialShapeOf,
  connectBody,
  declaresFields,
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
  commissionBps: null,
  serviceRatesCents: {},
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

describe('carrier shipping settings', () => {
  const withServices: CarrierConnectionView = {
    ...view,
    defaultServiceCode: 'std',
    services: [
      { code: 'std', label: 'Standard', active: true },
      { code: 'exp', label: 'Express', active: true }
    ],
    defaultShippingFeeCents: 500,
    minShippingFeeCents: 300,
    maxShippingFeeCents: 900
  }

  it('shows the money as dollars and sends cents, only for what changed', () => {
    const draft = carrierRulesDraftOf(withServices)
    expect(draft.defaultFee).toBe('5.00')
    expect(carrierRulesChanges(withServices, draft)).toEqual({})
    const edited = {
      ...draft,
      defaultFee: '6,5',
      maxFee: '',
      defaultShippingPayer: 'recipient',
      labelFormat: 'pdf_a4',
      maxDeliveryAttempts: '5',
      pollIntervalMinutes: '15',
      remittanceDeductsFee: true,
      defaultServiceCode: 'exp',
      services: [
        { code: 'std', label: ' Standard plus ', active: true },
        { code: 'exp', label: 'Express', active: false }
      ]
    }
    expect(carrierRulesChanges(withServices, edited)).toEqual({
      defaultShippingFeeCents: 650,
      maxShippingFeeCents: null,
      defaultShippingPayer: 'recipient',
      labelFormat: 'pdf_a4',
      maxDeliveryAttempts: 5,
      pollIntervalMinutes: 15,
      remittanceDeductsFee: true,
      defaultServiceCode: 'exp',
      services: [
        { code: 'std', label: 'Standard plus' },
        { code: 'exp', active: false }
      ]
    })
  })

  it('refuses what the table refuses', () => {
    const base = carrierRulesDraftOf(withServices)
    expect(carrierRulesProblems({ ...base, defaultFee: '1.234' })).toEqual(['fee'])
    expect(carrierRulesProblems({ ...base, minFee: '9', maxFee: '4' })).toEqual(['feeRange'])
    expect(carrierRulesProblems({ ...base, maxDeliveryAttempts: '11' })).toEqual(['attempts'])
    expect(carrierRulesProblems({ ...base, maxDeliveryAttempts: '0' })).toEqual(['attempts'])
    expect(carrierRulesProblems({ ...base, pollIntervalMinutes: '1441' })).toEqual(['poll'])
    expect(carrierRulesProblems({ ...base, pollIntervalMinutes: '' })).toEqual([])
    expect(
      carrierRulesProblems({ ...base, services: [{ code: 'std', label: ' ', active: true }] })
    ).toEqual(['serviceLabel'])
    // Switching the default service off needs another default first
    expect(
      carrierRulesProblems({
        ...base,
        services: [
          { code: 'std', label: 'Standard', active: false },
          { code: 'exp', label: 'Express', active: true }
        ]
      })
    ).toEqual(['defaultService'])
    expect(carrierRulesProblems({ ...base, defaultFee: '2000000' })).toEqual(['fee'])
  })

  it('sends nothing for what did not change, clears the interval and the fee on empty, and keeps the default', () => {
    const saved = { ...withServices, pollIntervalMinutes: 20 }
    const draft = {
      ...carrierRulesDraftOf(saved),
      pollIntervalMinutes: '',
      minFee: '',
      defaultServiceCode: '',
      services: [
        { code: 'std', label: 'Standard', active: true },
        { code: 'exp', label: 'Express', active: true },
        { code: 'gone', label: 'Not ours', active: false }
      ]
    }
    expect(carrierRulesChanges(saved, draft)).toEqual({
      pollIntervalMinutes: null,
      minShippingFeeCents: null
    })
  })

  it('knows what a connection declares', () => {
    expect(canPoll(['fetch_status'])).toBe(true)
    expect(canPoll([])).toBe(false)
    expect(acceptsCashOnDelivery(['cod'])).toBe(true)
    expect(acceptsCashOnDelivery([])).toBe(false)
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
  const external = { capabilities: [], hasCredentials: true, connectFields: [] }
  const internal = { capabilities: ['internal_guide'], hasCredentials: false, connectFields: [] }

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

const field = (
  key: string,
  patch: Partial<CarrierConnectFieldView> = {}
): CarrierConnectFieldView => ({
  key,
  labelKey: `settings.carriers.connect.fields.x.${key}`,
  label: null,
  helpKey: null,
  secret: false,
  required: true,
  multiple: false,
  ...patch
})
const declared = [
  field('username'),
  field('password', { secret: true }),
  field('site', { required: false })
]

describe('a carrier that declares its fields', () => {
  const target = { capabilities: [], hasCredentials: true, connectFields: declared }

  it('draws its own form and never the JSON box', () => {
    expect(declaresFields(target)).toBe(true)
    expect(declaresFields({ ...target, connectFields: [] })).toBe(false)
    // A courier the platform makes the guides for keeps its own form even if a field were declared
    expect(declaresFields({ ...target, capabilities: ['internal_guide'] })).toBe(false)
  })

  it('asks for every required field, and sends only what was typed', () => {
    const draft = { ...EMPTY_CONNECT_DRAFT, carrierId: 'x', credentials: '{"ignored":1}' }
    expect(connectProblems(draft, target)).toEqual(['fields'])
    const partial = { ...draft, fieldValues: { username: 'ana', password: '  ' } }
    expect(connectProblems(partial, target)).toEqual(['fields'])
    const ready = { ...draft, fieldValues: { username: ' ana ', password: 's3', site: '' } }
    expect(connectProblems(ready, target)).toEqual([])
    expect(connectBody(ready, target)).toEqual({
      carrierId: 'x',
      credentials: { username: 'ana', password: 's3' }
    })
  })

  it('sends a field that holds a list as its lines', () => {
    const lists = { ...target, connectFields: [field('hosts', { multiple: true })] }
    const draft = { ...EMPTY_CONNECT_DRAFT, carrierId: 'x', fieldValues: { hosts: 'a\n\nb\na' } }
    expect(connectBody(draft, lists).credentials).toEqual({ hosts: ['a', 'b'] })
  })
})

describe('editing the credentials', () => {
  const shape = credentialShapeOf(view, declared)

  it('keeps the saved credentials when nothing was typed', () => {
    const draft = carrierRulesDraftOf(view, shape.fields)
    expect(carrierRulesProblems(draft, shape)).toEqual([])
    expect(carrierRulesChanges(view, draft, shape)).toEqual({})
  })

  it('refuses a replacement that leaves a required field empty', () => {
    const draft = carrierRulesDraftOf(view, shape.fields)
    const typed = { ...draft, fieldValues: { ...draft.fieldValues, username: 'ana' } }
    expect(carrierRulesProblems(typed, shape)).toEqual(['fields'])
  })

  it('sends the whole set when every required field is typed', () => {
    const draft = carrierRulesDraftOf(view, shape.fields)
    const typed = { ...draft, fieldValues: { username: 'ana', password: 'p', site: '' } }
    expect(carrierRulesProblems(typed, shape)).toEqual([])
    expect(carrierRulesChanges(view, typed, shape)).toEqual({
      credentials: { username: 'ana', password: 'p' }
    })
  })

  it('ignores the JSON box when the carrier declares fields', () => {
    const draft = { ...carrierRulesDraftOf(view, shape.fields), credentials: '{' }
    expect(carrierRulesProblems(draft, shape)).toEqual([])
  })
})

describe('editing the contact and prefix of a courier', () => {
  const courier: CarrierConnectionView = {
    ...view,
    capabilities: ['internal_guide'],
    contact: { phone: '555', notes: 'rear door' },
    guidePrefix: 'JM'
  }
  const shape = credentialShapeOf(courier, [])

  it('starts from what the connection holds and changes nothing', () => {
    const draft = carrierRulesDraftOf(courier, shape.fields)
    // The name is the one of the connection: the contact does not keep the name typed when connecting
    expect(draft.courier).toEqual({ name: 'Main', phone: '555', notes: 'rear door', prefix: 'JM' })
    expect(carrierRulesProblems(draft, shape)).toEqual([])
    expect(carrierRulesChanges(courier, draft, shape)).toEqual({})
  })

  it('sends the complete contact when one part changes', () => {
    const draft = carrierRulesDraftOf(courier, shape.fields)
    const changed = { ...draft, courier: { ...draft.courier, phone: ' 777 ', prefix: 'AB' } }
    expect(carrierRulesProblems(changed, shape)).toEqual([])
    expect(carrierRulesChanges(courier, changed, shape)).toEqual({
      credentials: { name: 'Main', phone: '777', notes: 'rear door', prefix: 'AB' }
    })
  })

  it('does not send a change that is only spaces', () => {
    const draft = carrierRulesDraftOf(courier, shape.fields)
    const spaced = { ...draft, courier: { ...draft.courier, name: ' Main ', notes: 'rear door ' } }
    expect(carrierRulesChanges(courier, spaced, shape)).toEqual({})
  })

  it('names every limit of the contact that can be edited', () => {
    const draft = carrierRulesDraftOf(courier, shape.fields)
    const long = {
      ...draft,
      courier: { ...draft.courier, phone: ' ', notes: 'x'.repeat(5000), prefix: 'TOOLONG1' }
    }
    expect(carrierRulesProblems(long, shape)).toEqual([
      'courierPhone',
      'courierPrefix',
      'courierNotes'
    ])
  })

  it('names what is wrong with the contact', () => {
    const draft = carrierRulesDraftOf(courier, shape.fields)
    const bad = { ...draft, courier: { ...draft.courier, phone: ' ', prefix: 'ab' } }
    expect(carrierRulesProblems(bad, shape)).toEqual(['courierPhone', 'courierPrefix'])
  })

  it('does not ask a disconnected courier with no contact for one it is not editing', () => {
    const bare: CarrierConnectionView = { ...courier, contact: null, guidePrefix: null }
    const bareShape = credentialShapeOf(bare, [])
    const draft = carrierRulesDraftOf(bare, bareShape.fields)
    expect(carrierRulesProblems(draft, bareShape)).toEqual([])
  })
})
