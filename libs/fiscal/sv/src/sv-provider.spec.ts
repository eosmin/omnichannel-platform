import { FiscalEnvironment } from '@platform/core/domain'

import { SvBuildErrors, SvCredentialKeys, SvEndpoints, SvVoidRefusals } from './sv-constants'
import { svProvider } from './sv-provider'
import type { SvSigner } from './sv-signer'
import { ISSUER, sale } from './testing/sv-fixtures'

// A signer that is never called by these specs
const NO_SIGNER: SvSigner = { sign: () => Promise.reject(new Error('not called')) }

const CREDENTIALS = {
  [SvCredentialKeys.API_PASSWORD]: 'secret-api-password',
  [SvCredentialKeys.CERTIFICATE_PASSWORD]: 'secret-certificate-password',
  [SvCredentialKeys.CERTIFICATE]: 'secret-certificate'
}

describe('the manifest of the provider', () => {
  const provider = svProvider({ signer: NO_SIGNER })

  it('declares the three documents, with what a taxpayer needs of a customer and the credit note marked', () => {
    expect(provider.manifest.documentTypes.map(type => type.id)).toEqual(['01', '03', '05'])
    const [invoice, taxCredit, note] = provider.manifest.documentTypes
    expect(invoice?.requiredReceiverFields).toEqual([])
    expect(taxCredit?.requiredReceiverFields).toEqual([
      'name',
      'taxId',
      'registrationId',
      'economicActivity',
      'address'
    ])
    expect(note?.creditNote).toBe(true)
    expect(taxCredit?.creditNote).toBeUndefined()
  })

  it('numbers by type, establishment and point of sale, and asks the issuer for the codes it needs', () => {
    expect(provider.manifest.sequence).toEqual({
      perDocumentType: true,
      perEstablishment: true,
      perPointOfSale: true
    })
    expect(provider.manifest.requiredIssuerFields).toEqual(
      expect.arrayContaining(['establishmentCode', 'pointOfSaleCode'])
    )
    // It must be able to say the type before it builds (the registry refuses a provider that cannot)
    expect(typeof provider.resolveDocumentType).toBe('function')
  })

  it('names its credentials and never holds a value of them', () => {
    expect(provider.manifest.credentialKeys).toEqual([
      'apiPassword',
      'certificatePassword',
      'certificate'
    ])
    for (const value of Object.values(CREDENTIALS)) {
      expect(JSON.stringify(provider.manifest)).not.toContain(value)
    }
  })

  it('works in both environments, each with its own endpoint and no trailing slash', () => {
    // Only the sandbox until the owner authorizes production (Step 4B.7c-8): the real environment needs its own configuration
    expect(provider.manifest.environments).toEqual([FiscalEnvironment.SANDBOX])
    expect(SvEndpoints[FiscalEnvironment.SANDBOX].baseUrl).toBe('https://apitest.dtes.mh.gob.sv')
    expect(SvEndpoints[FiscalEnvironment.PRODUCTION].baseUrl).toBe('https://api.dtes.mh.gob.sv')
    for (const environment of Object.values(SvEndpoints)) {
      for (const path of [
        environment.baseUrl,
        environment.auth,
        environment.reception,
        environment.consult,
        environment.invalidation,
        environment.contingency
      ]) {
        expect(path.endsWith('/')).toBe(false)
      }
    }
  })
})

describe('the check of an issuer', () => {
  it('refuses an issuer of the real environment until production is authorized', async () => {
    const check = await svProvider({ signer: NO_SIGNER }).validateIssuer(
      { ...ISSUER, environment: FiscalEnvironment.PRODUCTION },
      { credentials: CREDENTIALS }
    )
    expect(check).toEqual({ ok: false, problems: ['environment'] })
  })

  const provider = svProvider({ signer: NO_SIGNER })

  it('accepts a complete issuer with its three credentials', async () => {
    expect(await provider.validateIssuer(ISSUER, { credentials: CREDENTIALS })).toEqual({
      ok: true,
      problems: []
    })
  })

  it('names what is missing, in fields and credential names, without a value', async () => {
    const check = await provider.validateIssuer(
      { ...ISSUER, pointOfSaleCode: null, email: null },
      {
        credentials: {
          [SvCredentialKeys.API_PASSWORD]: 'secret-api-password',
          [SvCredentialKeys.CERTIFICATE]: ' '
        }
      }
    )
    expect(check.ok).toBe(false)
    expect([...check.problems].sort()).toEqual(
      ['certificatePassword', 'email', 'pointOfSaleCode'].sort()
    )
    for (const value of Object.values(CREDENTIALS))
      expect(JSON.stringify(check)).not.toContain(value)
  })
})

describe('the invalidation and the build refusals', () => {
  const provider = svProvider({ signer: NO_SIGNER })
  const ctx = { issuer: ISSUER, credentials: CREDENTIALS, idempotencyKey: 'k', attempt: 1 }

  it('refuses an invalidation that lacks what the authority asks, with a code and without calling anyone', async () => {
    const answer = await provider.void(
      { documentType: '03', externalNumber: 'x', providerData: null, payload: {} },
      'r',
      ctx
    )
    expect(answer).toEqual({ voided: false, reason: SvVoidRefusals.DOCUMENT_INCOMPLETE })
  })

  it('declares what an invalidation asks of the person', () => {
    expect(provider.manifest.voidInputs).toEqual({
      kinds: ['correction', 'rescission', 'other'],
      requiresParties: true,
      kindsWithReplacement: ['correction', 'other'],
      reasonMaxLength: 200
    })
  })

  it('refuses an unbuildable sale with a code, as a rejected promise', async () => {
    await expect(provider.build(sale({ totalCents: 1 }))).rejects.toMatchObject({
      code: SvBuildErrors.SALE_TOTALS_MISMATCH
    })
  })
})
