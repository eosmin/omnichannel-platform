import { C807Plugin } from '@platform/carriers/c807'
import { LabelFormat } from '@platform/core/domain'

import {
  C807_FAKE_PASSWORD,
  C807_FAKE_TOKEN,
  C807_FAKE_USERNAME,
  C807_FAKE_WEBHOOK_SECRET,
  c807WebhookBody,
  fakeC807
} from '../builders/c807-fixtures'
import { buildCarrierContext, buildCreateShipmentParams } from '../builders/carrier-plugin'

import { testCarrierPluginContract } from './carrier-plugin.contract'

const rawBody = JSON.stringify(c807WebhookBody)

// The carrier of the suite is a C807 that answers like its documentation; nothing leaves the machine
beforeEach(() => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(fakeC807().fetch)
})
afterEach(() => jest.restoreAllMocks())

testCarrierPluginContract(() => new C807Plugin(), {
  context: buildCarrierContext({
    // The suite connects with what the context holds, so the context also carries the delivery type that `connect` asks for
    credentials: {
      username: C807_FAKE_USERNAME,
      password: C807_FAKE_PASSWORD,
      deliveryType: 'NRML'
    },
    metadata: { deliveryType: 'NRML' }
  }),
  createParams: buildCreateShipmentParams({
    labelFormat: LabelFormat.PDF_100X150,
    recipient: {
      name: 'Ana Recipient',
      phones: ['71234567'],
      email: 'ana@example.com',
      address: { line1: '5 Customer St', city: 'Santa Tecla', country: 'SV' },
      locationIds: { departmentId: '2', municipalityId: '4' }
    }
  }),
  webhook: {
    rawBody,
    headers: { 'x-webhook-secret': C807_FAKE_WEBHOOK_SECRET },
    body: c807WebhookBody,
    secret: C807_FAKE_WEBHOOK_SECRET,
    invalidHeaders: { 'x-webhook-secret': 'wrong' },
    emptyBody: { unexpected: true }
  },
  secrets: [C807_FAKE_PASSWORD, C807_FAKE_TOKEN, C807_FAKE_WEBHOOK_SECRET]
})
