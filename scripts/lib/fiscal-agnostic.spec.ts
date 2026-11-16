import {
  ALLOWED_FILES,
  baselineGrowth,
  checkAgainstBaseline,
  countReferences,
  isScanned,
  lowerBaseline,
  namesFiscalProvider
} from './fiscal-agnostic'

describe('isScanned', () => {
  it('scans the platform, the port and the runtime, and leaves out the provider packages, tests and migrations', () => {
    for (const file of [
      'apps/api/src/modules/fiscal/fiscal.service.ts',
      'apps/worker/src/processors/heavy-processing.processor.ts',
      'libs/core/domain/fiscal-constants.ts',
      'libs/fiscal/sdk/src/fiscal-provider.interface.ts',
      'libs/fiscal/runtime/src/fiscal-documents.service.ts',
      'apps/web/components/orders/order-fiscal.tsx'
    ]) {
      expect(isScanned(file)).toBe(true)
    }
    for (const file of [
      'libs/fiscal/simulator/src/simulator-provider.ts',
      'libs/fiscal/sv/src/provider.ts',
      'apps/api/src/modules/fiscal/fiscal.service.spec.ts',
      'libs/core/database/prisma/migrations/20261221100000_fiscal_documents/migration.sql',
      'docs/TDD_18_Finance.md'
    ]) {
      expect(isScanned(file)).toBe(false)
    }
  })

  it('has one composition root, with its reason in writing', () => {
    expect(Object.keys(ALLOWED_FILES)).toEqual(['libs/fiscal/runtime/src/official-providers.ts'])
    expect(isScanned('libs/fiscal/runtime/src/official-providers.ts')).toBe(false)
    // The roots of the other plugins are scanned too, and the runtime's other files with them
    expect(isScanned('libs/channels/whatsapp/src/plugin.ts')).toBe(true)
    expect(isScanned('libs/carriers/local/src/local-carrier.plugin.ts')).toBe(true)
    expect(isScanned('libs/plugins/sdk/src/plugin-scopes.ts')).toBe(true)
    expect(isScanned('libs/fiscal/runtime/src/fiscal-rules.ts')).toBe(true)
    for (const reason of Object.values(ALLOWED_FILES)) expect(reason.length).toBeGreaterThan(20)
  })
})

describe('namesFiscalProvider', () => {
  it('finds the authority of a country, its document acronyms and a provider package', () => {
    expect(namesFiscalProvider('// sent to Hacienda')).toBe(true)
    expect(namesFiscalProvider('const kind = "DTE"')).toBe(true)
    expect(namesFiscalProvider("import { x } from '@platform/fiscal/sv'")).toBe(true)
    expect(namesFiscalProvider("import { x } from '@platform/fiscal/simulator'")).toBe(true)
    expect(namesFiscalProvider("if (id === 'simulator') return")).toBe(true)
  })

  it('leaves the port and the runtime, and ordinary words, alone', () => {
    expect(namesFiscalProvider("import { x } from '@platform/fiscal/sdk-sv'")).toBe(true)
    expect(namesFiscalProvider("import { x } from '@platform/fiscal/runtime-x'")).toBe(true)
    expect(namesFiscalProvider('// Dian called about the order')).toBe(false)
    expect(namesFiscalProvider('// the DIAN of Colombia')).toBe(true)
    expect(namesFiscalProvider('siiXcl')).toBe(false)
    expect(namesFiscalProvider("import { x } from '@platform/fiscal/sdk'")).toBe(false)
    expect(namesFiscalProvider("import { x } from '@platform/fiscal/runtime'")).toBe(false)
    expect(namesFiscalProvider('const nit = 1 // a nit about the document')).toBe(false)
    expect(namesFiscalProvider('a document type the provider declares')).toBe(false)
  })

  it('counts code and comment lines apart', () => {
    expect(countReferences("const a = 'simulator'\n// Hacienda\nconst b = 1")).toEqual({
      code: 1,
      comment: 1
    })
  })
})

describe('the ratchet', () => {
  it('fails on a new reference and on a higher count, and only lowers', () => {
    expect(checkAgainstBaseline({}, { 'a.ts': { code: 1, comment: 0 } })).toHaveLength(1)
    expect(
      checkAgainstBaseline({ 'a.ts': { code: 1, comment: 0 } }, { 'a.ts': { code: 2, comment: 0 } })
    ).toHaveLength(1)
    expect(
      lowerBaseline({ 'a.ts': { code: 2, comment: 0 } }, { 'a.ts': { code: 1, comment: 0 } })
    ).toEqual({ 'a.ts': { code: 1, comment: 0 } })
    expect(
      baselineGrowth({ 'a.ts': { code: 1, comment: 0 } }, { 'a.ts': { code: 2, comment: 0 } })
    ).toEqual(['a.ts'])
  })
})
