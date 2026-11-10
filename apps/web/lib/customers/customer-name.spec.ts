import {
  customerListLabel,
  customerDisplayName,
  initialsOfName,
  visitorTail
} from './customer-name'

const base = { name: null, email: null, phone: null, identities: [] }

describe('customerDisplayName', () => {
  it('prefers the name, then the e-mail, then the phone', () => {
    expect(customerDisplayName({ ...base, name: 'Juan', email: 'j@x.com' })).toBe('Juan')
    expect(customerDisplayName({ ...base, email: 'j@x.com', phone: '+5037' })).toBe('j@x.com')
    expect(customerDisplayName({ ...base, phone: '+5037' })).toBe('+5037')
  })

  it('falls back to the first channel, and then to nothing', () => {
    const identity = {
      id: 'i1',
      channelType: 'whatsapp',
      channelIdentity: '5037',
      displayName: null,
      lastInboundAt: null,
      anonymousCustomers: false
    }
    expect(customerDisplayName({ ...base, identities: [identity] })).toBe('5037')
    expect(customerDisplayName({ ...base, name: '  ' })).toBeNull()
  })
})

describe('an anonymous customer, as the channel declares it', () => {
  const visitor = {
    id: 'i2',
    channelType: 'acme_chat',
    channelIdentity: '3f0c1d52-0000-4000-8000-00000000ab98',
    displayName: null,
    lastInboundAt: null,
    anonymousCustomers: true
  }

  it('is not named by its random id', () => {
    expect(customerDisplayName({ ...base, identities: [visitor] })).toBeNull()
  })

  it('is named by the end of the id, as the inbox does', () => {
    expect(visitorTail({ identities: [visitor] })).toBe('ab98')
    expect(visitorTail({ identities: [] })).toBeNull()
    expect(visitorTail({ identities: [{ ...visitor, anonymousCustomers: false }] })).toBeNull()
  })

  it('is decided by the flag and never by the id of the channel', () => {
    const widgetNamed = { ...visitor, channelType: 'web_widget', anonymousCustomers: false }
    expect(visitorTail({ identities: [widgetNamed] })).toBeNull()
    expect(customerDisplayName({ ...base, identities: [widgetNamed] })).toBe(
      widgetNamed.channelIdentity
    )
  })
})

describe('initialsOfName', () => {
  it('takes two letters at most', () => {
    expect(initialsOfName('juan carlos pérez')).toBe('JC')
    expect(initialsOfName(null)).toBe('?')
  })
})

describe('customerListLabel', () => {
  it('takes the name, else the e-mail, else the phone', () => {
    expect(customerListLabel({ name: 'Ana', email: 'a@x.com', phone: '1' })).toBe('Ana')
    expect(customerListLabel({ name: ' ', email: 'a@x.com', phone: '1' })).toBe('a@x.com')
    expect(customerListLabel({ name: null, email: null, phone: '1' })).toBe('1')
  })

  it('is null when nothing names the customer', () => {
    expect(customerListLabel({ name: null, email: null, phone: null })).toBeNull()
  })
})
