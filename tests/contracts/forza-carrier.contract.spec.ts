import { createForzaCarrierPlugin } from '@platform/carriers/forza'
import { LabelFormat } from '@platform/core/domain'

import { buildCarrierContext, buildCreateShipmentParams } from '../builders/carrier-plugin'
import {
  FORZA_FAKE_ACCOUNT,
  FORZA_FAKE_BASE_URL,
  FORZA_FAKE_COD_APP,
  FORZA_FAKE_SECRET_KEY,
  fakeForza
} from '../builders/forza-fixtures'

import { testCarrierPluginContract } from './carrier-plugin.contract'

// The carrier of the suite is a Forza that answers like its documentation and checks the signature; nothing leaves the machine.
// The plugin declares no webhook, so the suite asks for none
testCarrierPluginContract(() => createForzaCarrierPlugin({ fetch: fakeForza().fetch }), {
  context: buildCarrierContext({
    // The suite connects with what the context holds, so it carries the fields that `connect` asks for
    credentials: {
      codApp: FORZA_FAKE_COD_APP,
      secretKey: FORZA_FAKE_SECRET_KEY,
      bankAccountId: FORZA_FAKE_ACCOUNT,
      idClient: 1,
      country: 'GT',
      baseUrl: FORZA_FAKE_BASE_URL,
      codeOfReference: 111,
      originHeaderCodeTownship: '0101',
      bankId: '33',
      bankAccountName: 'FAKE HOLDER',
      bankAccountType: 'MONETARIA'
    },
    metadata: {}
  }),
  createParams: buildCreateShipmentParams({
    labelFormat: LabelFormat.PDF_100X150,
    recipient: {
      name: 'Ana Recipient',
      phones: ['55550001'],
      address: { line1: '5 Customer St', city: 'Chimaltenango', country: 'GT' },
      locationIds: { departmentId: '04', municipalityId: '0401' }
    }
  }),
  secrets: [FORZA_FAKE_SECRET_KEY, FORZA_FAKE_ACCOUNT]
})
