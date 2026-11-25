import { ConsentPurposes, COOKIE_POLICY_VERSION } from '@platform/core/compliance'
import { DSR_REQUEST_KEY_MAX_LENGTH, DSR_REQUEST_KEY_MIN_LENGTH } from '@platform/core/domain'

import {
  cookieConsentSchema,
  dsrFormKeyBodySchema,
  listConsentQuerySchema,
  recordConsentSchema
} from './compliance.schemas'

const CUSTOMER = '0d0f5f0e-6c1a-4d6e-9d57-3f1b1c3a7e21'
const VISITOR = '5a1c3d2e-9b7f-4a6d-8c11-2e4f6a8b0c13'
const categories = { functional: true, analytics: false, marketing: false }

describe('recordConsentSchema', () => {
  it('takes a customer, a known purpose and an answer', () => {
    const parsed = recordConsentSchema.parse({
      customerId: CUSTOMER,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: false
    })
    expect(parsed.granted).toBe(false)
  })

  it.each([
    ['a legal basis in the body', { legalBasis: 'consent' }],
    ['a store in the body', { storeId: CUSTOMER }],
    ['an unknown purpose', { purpose: 'marketing' }],
    ['a text for the answer', { granted: 'yes' }]
  ])('refuses %s', (_name, extra) => {
    const body = {
      customerId: CUSTOMER,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: true,
      ...extra
    }
    expect(recordConsentSchema.safeParse(body).success).toBe(false)
  })
})

describe('listConsentQuerySchema', () => {
  it('needs the customer and nothing else', () => {
    expect(listConsentQuerySchema.safeParse({ customerId: CUSTOMER }).success).toBe(true)
    expect(listConsentQuerySchema.safeParse({}).success).toBe(false)
    expect(
      listConsentQuerySchema.safeParse({ customerId: CUSTOMER, storeId: CUSTOMER }).success
    ).toBe(false)
  })
})

describe('cookieConsentSchema', () => {
  const body = { visitorId: VISITOR, categories, policyVersion: COOKIE_POLICY_VERSION }

  it('takes every choosable category and the current policy version', () => {
    expect(cookieConsentSchema.parse(body).visitorId).toBe(VISITOR)
  })

  it('lower-cases the visitor id so one visitor is one key', () => {
    expect(cookieConsentSchema.parse({ ...body, visitorId: VISITOR.toUpperCase() }).visitorId).toBe(
      VISITOR
    )
  })

  it.each([
    ['a version the server does not know', { policyVersion: '1999-01-01' }],
    ['a missing category', { categories: { functional: true } }],
    ['the necessary category as a choice', { categories: { ...categories, necessary: false } }],
    ['a user id in the body', { userId: CUSTOMER }],
    ['an id that is not a UUID', { visitorId: 'visitor-1' }]
  ])('refuses %s', (_name, extra) => {
    expect(cookieConsentSchema.safeParse({ ...body, ...extra }).success).toBe(false)
  })
})

describe('dsrFormKeyBodySchema', () => {
  // The same two numbers as the intake and the public form (`DSR_REQUEST_KEY_*`): the key the screen shows is the key this takes back
  it.each([
    ['the shortest key of the form', 'k'.repeat(DSR_REQUEST_KEY_MIN_LENGTH), true],
    ['the longest key of the form', 'k'.repeat(DSR_REQUEST_KEY_MAX_LENGTH), true],
    ['no key at all', null, true],
    ['one character short', 'k'.repeat(DSR_REQUEST_KEY_MIN_LENGTH - 1), false],
    ['one character long', 'k'.repeat(DSR_REQUEST_KEY_MAX_LENGTH + 1), false]
  ])('%s', (_name, current, accepted) => {
    expect(dsrFormKeyBodySchema.safeParse({ current }).success).toBe(accepted)
  })
})
