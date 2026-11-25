import { FiscalAuthorityProbeOutcome, FiscalEnvironment } from '@platform/core/domain'

import { activityName, isIdentityDocument } from './sv-catalog'
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

  it('declares the five documents, with what a taxpayer needs of a customer and the notes marked', () => {
    expect(provider.manifest.documentTypes.map(type => type.id)).toEqual([
      '01',
      '03',
      '04',
      '05',
      '06'
    ])
    const [invoice, taxCredit, remission, note, debit] = provider.manifest.documentTypes
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
    // The debit note is a taxpayer's document that names another, and is not a credit note
    expect(debit?.requiredReceiverFields).toEqual(taxCredit?.requiredReceiverFields)
    expect(debit?.debitNote).toBe(true)
    expect(debit?.creditNote).toBeUndefined()
    expect(note?.debitNote).toBeUndefined()
    // The remission note is no sale and cancels nothing: it asks for who the goods go to, with an identity document, not for a taxpayer
    expect(remission?.remissionNote).toBe(true)
    expect(remission?.creditNote).toBeUndefined()
    expect(remission?.debitNote).toBeUndefined()
    expect(remission?.requiredReceiverFields).toEqual([
      'name',
      'taxId',
      'economicActivity',
      'address'
    ])
    expect(taxCredit?.remissionNote).toBeUndefined()
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

  it('offers the catalogs a person chooses from, with the code the provider reads', () => {
    const { catalogs, issuerFieldCatalogs } = provider.manifest
    expect(issuerFieldCatalogs).toEqual({ activityCode: 'activities' })
    expect(catalogs?.['activities']?.find(option => option.code === '47119')?.label).toMatch(/\S/)
    expect(catalogs?.['identityDocuments']).toContainEqual({ code: '36', label: 'NIT' })
    // Every code of the list is one the provider itself accepts
    for (const option of catalogs?.['identityDocuments'] ?? []) {
      expect(isIdentityDocument(option.code)).toBe(true)
      expect(option.label).toMatch(/\S/)
    }
    for (const option of catalogs?.['activities'] ?? [])
      expect(activityName(option.code)).not.toBeNull()
  })

  it('declares what an invalidation asks of the person', () => {
    expect(provider.manifest.voidInputs).toEqual({
      kinds: ['correction', 'rescission', 'other'],
      requiresParties: true,
      identityCatalog: 'identityDocuments',
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

describe('the probe of the authority (D2c)', () => {
  const respond = (status: number, body: unknown) => {
    let calls = 0
    const fetch = () => {
      calls += 1
      return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) })
    }
    return { fetch, calls: () => calls }
  }
  const ctx = (credentials: Record<string, unknown>) => ({
    issuer: { ...ISSUER, environment: FiscalEnvironment.SANDBOX },
    credentials,
    idempotencyKey: 'probe',
    attempt: 1
  })

  it('declares the days after which a contingency needs a technical report', () => {
    const provider = svProvider({ signer: NO_SIGNER })
    expect(provider.manifest.contingencyMode?.technicalReportAfterDays).toBe(3)
    expect(typeof provider.probeAuthority).toBe('function')
  })

  it('says reachable when the authority gives a token, and unreachable when it does not answer', async () => {
    const up = respond(200, { status: 'OK', body: { token: 'Bearer t' } })
    const reachable = svProvider({ signer: NO_SIGNER, fetch: up.fetch })
    expect(await reachable.probeAuthority?.(ctx(CREDENTIALS))).toBe(
      FiscalAuthorityProbeOutcome.REACHABLE
    )
    const down = respond(503, { status: 'ERROR' })
    const unreachable = svProvider({ signer: NO_SIGNER, fetch: down.fetch })
    expect(await unreachable.probeAuthority?.(ctx(CREDENTIALS))).toBe(
      FiscalAuthorityProbeOutcome.UNREACHABLE
    )
  })

  it('says the credentials were refused, and sends nothing without credentials', async () => {
    const refused = respond(401, { status: 'ERROR' })
    const provider = svProvider({ signer: NO_SIGNER, fetch: refused.fetch })
    expect(await provider.probeAuthority?.(ctx(CREDENTIALS))).toBe(
      FiscalAuthorityProbeOutcome.CREDENTIALS_REJECTED
    )
    const none = respond(200, {})
    const bare = svProvider({ signer: NO_SIGNER, fetch: none.fetch })
    expect(await bare.probeAuthority?.(ctx({}))).toBe(FiscalAuthorityProbeOutcome.INCONCLUSIVE)
    expect(none.calls()).toBe(0)
  })
})
