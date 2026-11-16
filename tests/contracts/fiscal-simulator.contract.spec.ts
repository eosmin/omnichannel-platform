import { FiscalEnvironment } from '@platform/core/domain'
import { simulatorProvider, SimulatorRules } from '@platform/fiscal/simulator'

import { testFiscalProviderContract } from './fiscal-provider.contract'

// The simulator passes the same contract the real provider will pass (TDD_18 §8.1)
const SIGNING_KEY = 'contract-signing-key-not-a-secret'

testFiscalProviderContract(() => simulatorProvider(), {
  issuer: {
    legalName: 'Contract Issuer',
    taxId: 'ISSUER-TAX-ID',
    registrationId: null,
    address: { line1: 'Calle 1', city: 'Ciudad' },
    activityCode: null,
    establishmentCode: null,
    environment: FiscalEnvironment.SANDBOX
  },
  credentials: { signingKey: SIGNING_KEY },
  secrets: [SIGNING_KEY],
  receivers: {
    plain: { name: 'Ana', taxId: null },
    refused: { name: 'Ana', taxId: SimulatorRules.REJECT },
    unavailable: { name: 'Ana', taxId: `${SimulatorRules.UNAVAILABLE}-1` },
    lostAnswer: { name: 'Ana', taxId: SimulatorRules.LOST },
    incomplete: { name: null, taxId: '1234-5' }
  }
})
