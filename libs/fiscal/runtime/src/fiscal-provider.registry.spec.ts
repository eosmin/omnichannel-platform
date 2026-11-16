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

describe('the providers of a deployment', () => {
  it('registers the simulator in development and test only: staging, production and an unset environment never get it', () => {
    expect(officialFiscalProviders('development')).toHaveLength(1)
    expect(officialFiscalProviders('test')).toHaveLength(1)
    for (const env of ['staging', 'production', undefined, '', 'Production']) {
      expect(officialFiscalProviders(env)).toEqual([])
    }
  })
})
