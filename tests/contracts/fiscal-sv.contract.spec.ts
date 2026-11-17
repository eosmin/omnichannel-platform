import { SvCredentialKeys, officialSigner, svProvider } from '@platform/fiscal/sv'

import {
  FAKE,
  startFakeAuthority,
  type FakeAuthority
} from '../../libs/fiscal/sv/src/testing/fake-authority'
import { ISSUER } from '../../libs/fiscal/sv/src/testing/sv-fixtures'

import { testFiscalProviderContract } from './fiscal-provider.contract'

// The provider of El Salvador passes the same contract as the simulator (TDD_18 §8.1), against a server of our own that plays the authority
// and its signing service (nothing reaches the real one). Invalidation is not built yet (Step 4B.7c-4), so that part of the contract is skipped.
let authority: FakeAuthority

beforeAll(async () => {
  authority = await startFakeAuthority()
})
beforeEach(() => {
  authority.forgetDocuments()
})
afterAll(async () => {
  await authority.close()
})

testFiscalProviderContract(
  () =>
    svProvider({
      signer: officialSigner({
        baseUrl: authority.baseUrl,
        fetch: (url, init) => fetch(url, init),
        timeoutMs: 2000
      }),
      endpoints: authority.endpoints
    }),
  {
    issuer: ISSUER,
    credentials: {
      [SvCredentialKeys.API_PASSWORD]: FAKE.API_PASSWORD,
      [SvCredentialKeys.CERTIFICATE_PASSWORD]: FAKE.KEY_PASSWORD
    },
    secrets: [FAKE.API_PASSWORD, FAKE.KEY_PASSWORD],
    voidImplemented: false,
    receivers: {
      plain: { name: null, taxId: null },
      refused: { name: 'Ana', taxId: FAKE.REJECT },
      unavailable: { name: 'Ana', taxId: FAKE.DOWN },
      lostAnswer: { name: 'Ana', taxId: FAKE.LOST },
      // A taxpayer with no address and no activity: a tax credit document that cannot be made
      incomplete: {
        name: 'Cliente Contribuyente S.A.',
        taxId: '0614-020202-102-3',
        registrationId: '765432-1'
      }
    },
    creditNote: {
      receiver: {
        name: 'Cliente Contribuyente S.A.',
        taxId: '0614-020202-102-3',
        registrationId: '765432-1',
        economicActivity: '47119',
        address: { department: '06', municipality: '20', district: '02', complement: 'Avenida 2' }
      },
      credited: {
        documentType: '03',
        externalNumber: 'EXT-1',
        issuedAt: '2026-11-16T15:00:00.000Z',
        providerData: {
          generationCode: 'AC54E9DB-79C5-42CE-B430-EC552C97EFBA',
          issueDate: '2026-11-16'
        }
      },
      marker: 'AC54E9DB-79C5-42CE-B430-EC552C97EFBA'
    }
  }
)
