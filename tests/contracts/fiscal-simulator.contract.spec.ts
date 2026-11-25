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
    establishmentType: null,
    pointOfSaleCode: null,
    phone: null,
    email: null,
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

describe('the simulator checks the fiscal data of a customer by its one rule', () => {
  const receiver = {
    name: 'Ana',
    registrationId: null,
    address: null,
    email: null,
    phone: null
  }
  it('refuses a tax id with spaces, by field and code, and accepts one without', () => {
    const provider = simulatorProvider()
    expect(provider.validateReceiver({ ...receiver, taxId: '12 34' })).toEqual([
      { field: 'taxId', code: SimulatorRules.TAX_ID_WITH_SPACES }
    ])
    expect(provider.validateReceiver({ ...receiver, taxId: '1234' })).toEqual([])
    expect(provider.validateReceiver({ ...receiver, taxId: null })).toEqual([])
  })

  it('holds the same rule for the tax id of a party that is not a receiver', () => {
    const provider = simulatorProvider()
    expect(provider.validatePartyTaxId('12 34')).toBe(false)
    expect(provider.validatePartyTaxId('1234')).toBe(true)
  })
})
