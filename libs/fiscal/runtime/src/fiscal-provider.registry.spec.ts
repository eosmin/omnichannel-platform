import type { FiscalDocumentProvider, FiscalProviderManifest } from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'

import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { officialFiscalProviders } from './official-providers'

describe('the registry of fiscal providers', () => {
  it('finds a provider by its id and lists what each declares, with no credential', () => {
    const registry = new FiscalProviderRegistry([simulatorProvider()])
    expect(registry.find(simulatorProvider().id)).toBeDefined()
    expect(registry.find('no-such-provider')).toBeUndefined()
    const [listed] = registry.list()
    expect(listed?.manifest.credentialKeys).toEqual(['signingKey'])
  })

  describe('the catalogs of a manifest', () => {
    const base = simulatorProvider()
    // The simulator with another manifest: its methods stay on the prototype
    const withManifest = (extra: Partial<FiscalProviderManifest>): FiscalDocumentProvider =>
      Object.create(base, {
        manifest: { value: { ...base.manifest, ...extra }, enumerable: true }
      }) as FiscalDocumentProvider

    it('lists them for the settings screen', () => {
      const registry = new FiscalProviderRegistry([
        withManifest({
          catalogs: { kinds: [{ code: '1', label: 'One' }] },
          issuerFieldCatalogs: { establishmentType: 'kinds' }
        })
      ])
      expect(registry.list()[0]?.manifest.catalogs).toEqual({
        kinds: [{ code: '1', label: 'One' }]
      })
    })

    it('refuses a catalog with a repeated or empty code or with no words', () => {
      for (const options of [
        [
          { code: '1', label: 'One' },
          { code: '1', label: 'Again' }
        ],
        [
          { code: '1', label: 'One' },
          { code: '1 ', label: 'One with a blank' }
        ],
        [{ code: ' ', label: 'Blank' }],
        [{ code: '1', label: '' }],
        []
      ]) {
        expect(
          () => new FiscalProviderRegistry([withManifest({ catalogs: { kinds: options } })])
        ).toThrow(/is not valid/)
      }
    })

    it('does not take a property every object has for a catalog', () => {
      const catalogs = { kinds: [{ code: '1', label: 'One' }] }
      for (const name of ['constructor', 'toString', '__proto__']) {
        expect(
          () =>
            new FiscalProviderRegistry([
              withManifest({ catalogs, issuerFieldCatalogs: { activityCode: name } })
            ])
        ).toThrow(/does not have/)
      }
    })

    it('refuses a field or an identity list that names a catalog the manifest does not have', () => {
      expect(
        () =>
          new FiscalProviderRegistry([withManifest({ issuerFieldCatalogs: { activityCode: 'x' } })])
      ).toThrow(/does not have/)
      expect(
        () =>
          new FiscalProviderRegistry([
            withManifest({
              voidInputs: { kinds: [], requiresParties: true, identityCatalog: 'missing' }
            })
          ])
      ).toThrow(/does not have/)
    })
  })

  it('refuses two providers under the same id', () => {
    expect(() => new FiscalProviderRegistry([simulatorProvider(), simulatorProvider()])).toThrow(
      /share the id/
    )
  })
})

describe('the manifest of a provider', () => {
  const withTypes = (ids: string[]) => {
    const provider = simulatorProvider()
    return {
      ...provider,
      id: provider.id,
      manifest: {
        ...provider.manifest,
        documentTypes: ids.map(id => ({ id, label: id, requiredReceiverFields: [] }))
      }
    } as unknown as ReturnType<typeof simulatorProvider>
  }

  it('is refused when a type is empty, repeated or the placeholder of core', () => {
    for (const ids of [[''], ['a', 'a'], ['pending']]) {
      expect(() => new FiscalProviderRegistry([withTypes(ids)])).toThrow(/not valid/)
    }
    expect(() => new FiscalProviderRegistry([withTypes(['a', 'b'])])).not.toThrow()
  })
})

describe('the contingency mode of a provider', () => {
  const mode = {
    reasons: ['down', 'other'],
    authorityDownReason: 'down',
    transmitWithinHours: 72,
    maxDocumentsPerEvent: 1000,
    requiresResponsible: true
  }
  const make = (
    declared: Partial<typeof mode> | undefined,
    methods: { report: boolean; defer: boolean }
  ) => {
    const provider = simulatorProvider()
    return {
      ...provider,
      manifest: {
        ...provider.manifest,
        ...(declared === undefined ? {} : { contingencyMode: { ...mode, ...declared } })
      },
      ...(methods.report ? { reportContingency: () => Promise.reject(new Error('unused')) } : {}),
      ...(methods.defer ? { deferDocument: () => Promise.reject(new Error('unused')) } : {})
    } as unknown as ReturnType<typeof simulatorProvider>
  }
  const both = { report: true, defer: true }

  it('is accepted when it can sign a document in contingency and report it', () => {
    expect(() => new FiscalProviderRegistry([make({}, both)])).not.toThrow()
    // A provider with no mode needs neither
    expect(
      () => new FiscalProviderRegistry([make(undefined, { report: false, defer: false })])
    ).not.toThrow()
  })

  it('is refused without the means to report it or to keep a document, or with numbers that make no sense', () => {
    const invalid = /contingency mode/
    expect(() => new FiscalProviderRegistry([make({}, { report: false, defer: true })])).toThrow(
      invalid
    )
    expect(() => new FiscalProviderRegistry([make({}, { report: true, defer: false })])).toThrow(
      invalid
    )
    for (const declared of [
      { reasons: [] },
      { authorityDownReason: 'not-a-reason' },
      { transmitWithinHours: 0 },
      { transmitWithinHours: Number.NaN },
      { maxDocumentsPerEvent: 0 },
      { maxDocumentsPerEvent: 1.5 }
    ]) {
      expect(() => new FiscalProviderRegistry([make(declared, both)])).toThrow(invalid)
    }
  })
})

describe('the series a provider numbers by', () => {
  const numbering = (
    sequence: { perDocumentType?: boolean; perEstablishment?: boolean; perPointOfSale?: boolean },
    answers: boolean,
    requires: string[] = []
  ) => {
    const provider = simulatorProvider()
    return {
      id: provider.id,
      countryCode: provider.countryCode,
      manifest: {
        ...provider.manifest,
        requiredIssuerFields: [...provider.manifest.requiredIssuerFields, ...requires],
        sequence
      },
      ...(answers ? { resolveDocumentType: () => 'a' } : {})
    } as unknown as ReturnType<typeof simulatorProvider>
  }

  it('is refused when it is by document type and the provider cannot say which type a document is', () => {
    expect(() => new FiscalProviderRegistry([numbering({ perDocumentType: true }, false)])).toThrow(
      /resolveDocumentType/
    )
  })

  it('is refused when it is by establishment or point of sale and the manifest does not require that code of the issuer', () => {
    expect(
      () => new FiscalProviderRegistry([numbering({ perEstablishment: true }, false)])
    ).toThrow(/does not require/)
    expect(() => new FiscalProviderRegistry([numbering({ perPointOfSale: true }, false)])).toThrow(
      /does not require/
    )
    expect(
      () =>
        new FiscalProviderRegistry([
          numbering({ perEstablishment: true, perPointOfSale: true }, false, [
            'establishmentCode',
            'pointOfSaleCode'
          ])
        ])
    ).not.toThrow()
  })

  it('is accepted when the provider can say it, and when no type is asked for', () => {
    expect(
      () => new FiscalProviderRegistry([numbering({ perDocumentType: true }, true)])
    ).not.toThrow()
    expect(() => new FiscalProviderRegistry([numbering({}, false)])).not.toThrow()
  })
})

describe('the providers of a deployment', () => {
  it('registers the simulator in development and test only: staging, production and an unset environment never get it', () => {
    expect(officialFiscalProviders('development').map(provider => provider.id)).toEqual([
      'simulator'
    ])
    expect(officialFiscalProviders('test').map(provider => provider.id)).toEqual(['simulator'])
    for (const env of ['staging', 'production', undefined, '', 'Production']) {
      expect(officialFiscalProviders(env)).toEqual([])
    }
  })

  it('offers the provider that signs for real only where the deployment gives the address of its signing service', () => {
    const config = { signerUrl: 'http://signer.internal:8113' }
    // (the env schema keeps the address out of production until production is authorized; this function only reads what it is given)
    expect(officialFiscalProviders('production', config).map(provider => provider.id)).toEqual([
      'sv-dte'
    ])
    expect(officialFiscalProviders('staging', config).map(provider => provider.id)).toEqual([
      'sv-dte'
    ])
    // The simulator stays first where it is allowed
    expect(officialFiscalProviders('development', config).map(provider => provider.id)).toEqual([
      'simulator',
      'sv-dte'
    ])
    expect(officialFiscalProviders('production', { signerUrl: null })).toEqual([])
  })

  it('refuses a signing service address with credentials or another scheme', () => {
    expect(() =>
      officialFiscalProviders('production', { signerUrl: 'http://user:pass@signer:8113' })
    ).toThrow()
    expect(() =>
      officialFiscalProviders('production', { signerUrl: 'ftp://signer:8113' })
    ).toThrow()
  })
})
