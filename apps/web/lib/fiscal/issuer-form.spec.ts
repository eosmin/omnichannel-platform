import type { FiscalIssuerView, FiscalProviderView } from '@platform/api-client'
import { FiscalEnvironment, FiscalIssueOn, putFiscalIssuerSchema } from '@platform/core/domain'

import { emptyAddressRow } from './address-rows'
import {
  emptyIssuerDraft,
  issuerDraftOf,
  issuerInputOf,
  catalogOf,
  issuerProblems,
  sequenceOf
} from './issuer-form'

const provider: FiscalProviderView = {
  id: 'provider-a',
  countryCode: 'XX',
  manifest: {
    documentTypes: [],
    requiredIssuerFields: ['legalName', 'taxId', 'address', 'registrationId'],
    credentialKeys: ['signingKey', 'secret'],
    environments: [FiscalEnvironment.SANDBOX]
  },
  contingency: null
}

const issuer: FiscalIssuerView = {
  providerId: 'provider-a',
  legalName: 'Shop',
  taxId: '123',
  registrationId: 'R-1',
  address: { line1: 'Street 1' },
  activityCode: null,
  establishmentCode: null,
  establishmentType: null,
  pointOfSaleCode: null,
  phone: null,
  email: null,
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  nextSequence: 40,
  credentialsSet: true,
  updatedAt: '2026-11-16T10:00:00.000Z'
}

const filled = () => ({
  ...emptyIssuerDraft(provider),
  legalName: 'Shop',
  taxId: '123',
  registrationId: 'R-1',
  address: [{ ...emptyAddressRow(), key: 'line1', value: 'Street 1' }],
  credentials: { signingKey: 'k', secret: 's' }
})

describe('the form of the issuer', () => {
  it('starts from the first provider and the first environment its manifest names', () => {
    const draft = emptyIssuerDraft(provider)
    expect(draft.providerId).toBe('provider-a')
    expect(draft.environment).toBe(FiscalEnvironment.SANDBOX)
    expect(draft.issueOn).toBe(FiscalIssueOn.DELIVERED)
  })

  it('asks for what the manifest says the provider needs, and for nothing it does not', () => {
    const empty = issuerProblems(emptyIssuerDraft(provider), provider, null).map(each => each.field)
    expect(empty).toEqual(
      expect.arrayContaining(['legalName', 'taxId', 'registrationId', 'address', 'credentials'])
    )
    expect(empty).not.toContain('activityCode')
    expect(empty).not.toContain('establishmentCode')
  })

  it('passes a complete draft and makes a body the api accepts', () => {
    expect(issuerProblems(filled(), provider, null)).toEqual([])
    const body = issuerInputOf(filled(), provider)
    expect(putFiscalIssuerSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({
      providerId: 'provider-a',
      address: { line1: 'Street 1' },
      credentials: { signingKey: 'k', secret: 's' }
    })
    // Nothing typed for the correlative: not sent, so the issuer keeps its own
    expect(body).not.toHaveProperty('nextSequence')
  })

  it('refuses an environment the provider does not work in', () => {
    const draft = { ...filled(), environment: FiscalEnvironment.PRODUCTION }
    expect(issuerProblems(draft, provider, null)).toContainEqual({
      field: 'environment',
      kind: 'environment'
    })
  })

  it('lets the stored credentials stay when none are written for the same provider and environment', () => {
    const draft = { ...issuerDraftOf(issuer) }
    expect(issuerProblems(draft, provider, issuer)).toEqual([])
    expect(issuerInputOf(draft, provider)).not.toHaveProperty('credentials')
  })

  it('asks for every credential, not some, because what is sent replaces the stored ones whole', () => {
    const draft = { ...issuerDraftOf(issuer), credentials: { signingKey: 'new' } }
    expect(issuerProblems(draft, provider, issuer)).toContainEqual({
      field: 'credentials',
      kind: 'required'
    })
  })

  it('asks for new credentials when the provider changes', () => {
    const other: FiscalProviderView = { ...provider, id: 'provider-b' }
    const draft = { ...issuerDraftOf(issuer), providerId: 'provider-b' }
    expect(issuerProblems(draft, other, issuer)).toContainEqual({
      field: 'credentials',
      kind: 'required'
    })
  })

  it('only moves the correlative forward', () => {
    const draft = { ...issuerDraftOf(issuer), nextSequence: '39' }
    expect(issuerProblems(draft, provider, issuer)).toContainEqual({
      field: 'nextSequence',
      kind: 'sequence'
    })
    const forward = { ...issuerDraftOf(issuer), nextSequence: '40' }
    expect(issuerProblems(forward, provider, issuer)).toEqual([])
    expect(issuerInputOf(forward, provider)).toMatchObject({ nextSequence: 40 })
    expect(putFiscalIssuerSchema.safeParse(issuerInputOf(forward, provider)).success).toBe(true)
  })

  it('reads a correlative as a whole number within the limit of the database', () => {
    expect(sequenceOf('1')).toBe(1)
    expect(sequenceOf(' 2000000000 ')).toBe(2_000_000_000)
    for (const text of ['', '0', '-1', '1.5', 'x', '2000000001', '12345678901']) {
      expect(sequenceOf(text)).toBeNull()
    }
  })

  it('sends an empty optional field as null, as the api takes it', () => {
    const body = issuerInputOf({ ...filled(), registrationId: '  ' }, provider)
    expect(body.registrationId).toBeNull()
    expect(body.activityCode).toBeNull()
  })
})

describe('the fields the port added: point of sale, kind of establishment, phone and email', () => {
  const rich: FiscalProviderView = {
    ...provider,
    manifest: {
      ...provider.manifest,
      requiredIssuerFields: [
        ...provider.manifest.requiredIssuerFields,
        'activityCode',
        'establishmentType',
        'pointOfSaleCode',
        'phone',
        'email'
      ],
      catalogs: {
        activities: [
          { code: '47119', label: 'Retail' },
          { code: '10101', label: 'Farming' }
        ]
      },
      issuerFieldCatalogs: { activityCode: 'activities' }
    }
  }
  const full = () => ({
    ...filled(),
    activityCode: '47119',
    establishmentType: '02',
    pointOfSaleCode: 'P001',
    phone: '2222-0000',
    email: 'a@example.test'
  })

  it('asks for the ones the manifest requires, and only those', () => {
    const asked = issuerProblems(filled(), rich, null).map(each => each.field)
    expect(asked).toEqual(
      expect.arrayContaining([
        'activityCode',
        'establishmentType',
        'pointOfSaleCode',
        'phone',
        'email'
      ])
    )
    const plain = issuerProblems(filled(), provider, null).map(each => each.field)
    for (const field of ['establishmentType', 'pointOfSaleCode', 'phone', 'email'])
      expect(plain).not.toContain(field)
  })

  it('takes a value of the catalog the manifest names for the field, and refuses one it does not have', () => {
    expect(catalogOf(rich, 'activityCode')?.map(option => option.code)).toEqual(['47119', '10101'])
    expect(catalogOf(rich, 'phone')).toBeNull()
    expect(catalogOf(provider, 'activityCode')).toBeNull()
    expect(issuerProblems(full(), rich, null)).toEqual([])
    expect(issuerProblems({ ...full(), activityCode: '99999' }, rich, null)).toEqual([
      { field: 'activityCode', kind: 'unknown' }
    ])
    // A provider with no catalog for the field takes what is typed
    expect(issuerProblems({ ...full(), activityCode: '99999' }, provider, null)).toEqual([])
  })

  it('does not hold a saved code against the person who changes something else, but tells a new one', () => {
    const saved = { ...issuer, activityCode: 'OLD-CODE', providerId: 'provider-a' }
    const draft = { ...issuerDraftOf(saved), credentials: { signingKey: 'k', secret: 's' } }
    // The stored code is not in the list (a catalog that changed): the form is not refused for it
    const fields = issuerProblems({ ...draft, phone: '2222-0000' }, rich, saved).map(
      each => each.field
    )
    expect(fields).not.toContain('activityCode')
    // A different code that is not in the list is told
    expect(
      issuerProblems({ ...full(), activityCode: 'ANOTHER' }, rich, saved).map(each => each.field)
    ).toContain('activityCode')
    // And a code with blanks around it is the code
    expect(issuerProblems({ ...full(), activityCode: ' 47119 ' }, rich, null)).toEqual([])
  })

  it('counts the length the api takes', () => {
    expect(issuerProblems({ ...full(), phone: '1'.repeat(41) }, rich, null)).toEqual([
      { field: 'phone', kind: 'tooLong' }
    ])
    expect(issuerProblems({ ...full(), email: 'a'.repeat(201) }, rich, null)).toEqual([
      { field: 'email', kind: 'tooLong' }
    ])
  })

  it('sends them in a body the api accepts, trimmed, and null when empty so that a person can clear one', () => {
    const body = issuerInputOf({ ...full(), phone: ' 2222-0000 ' }, rich)
    expect(body).toMatchObject({
      establishmentType: '02',
      pointOfSaleCode: 'P001',
      phone: '2222-0000',
      email: 'a@example.test'
    })
    expect(putFiscalIssuerSchema.safeParse(body).success).toBe(true)
    const cleared = issuerInputOf({ ...full(), phone: '', email: '  ' }, provider)
    expect(cleared).toMatchObject({ phone: null, email: null })
  })

  it('starts again from what the issuer has', () => {
    const draft = issuerDraftOf({
      ...issuer,
      establishmentType: '02',
      pointOfSaleCode: 'P001',
      phone: '2222-0000',
      email: 'a@example.test'
    })
    expect(draft).toMatchObject({
      establishmentType: '02',
      pointOfSaleCode: 'P001',
      phone: '2222-0000',
      email: 'a@example.test'
    })
    expect(emptyIssuerDraft(rich)).toMatchObject({ phone: '', email: '', pointOfSaleCode: '' })
  })
})
