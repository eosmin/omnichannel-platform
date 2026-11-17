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
      'simulator',
      'sv-dte'
    ])
    expect(officialFiscalProviders('test')).toHaveLength(2)
    for (const env of ['staging', 'production', undefined, '', 'Production']) {
      expect(officialFiscalProviders(env)).toEqual([])
    }
  })
})
