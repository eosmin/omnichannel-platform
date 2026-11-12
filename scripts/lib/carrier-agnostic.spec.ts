import { CarrierId } from '@platform/core/domain'

import {
  ALLOWED_FILES,
  baselineGrowth,
  checkAgainstBaseline,
  countReferences,
  isScanned,
  lowerBaseline,
  namesCarrier,
  ORDINARY_WORD_IDS
} from './carrier-agnostic'

describe('isScanned', () => {
  it('scans production code outside the carrier plugins, the channel plugins included', () => {
    for (const file of [
      'apps/web/components/shipping/guide-card.tsx',
      'apps/api/src/modules/shipments/shipments.service.ts',
      'apps/worker/src/shipping/void-guide.processor.ts',
      'libs/core/shipping/src/shipping.service.ts',
      'libs/channels/whatsapp/src/plugin.ts',
      'libs/plugins/sdk/src/carrier-plugin.interface.ts',
      'libs/api-client/src/query-keys.ts'
    ]) {
      expect(isScanned(file)).toBe(true)
    }
  })

  it('leaves out the carrier plugins, tests, fixtures, migrations and what is not source', () => {
    for (const file of [
      'libs/carriers/local/src/local-carrier.plugin.ts',
      'libs/carriers/forza/src/index.ts',
      'apps/api/src/modules/shipments/shipments.service.spec.ts',
      'tests/api/carriers.spec.ts',
      'tests/builders/carrier-connection.ts',
      'apps/web-e2e/src/shipping.spec.ts',
      'libs/core/database/prisma/migrations/20261101_x/migration.sql',
      'libs/core/database/rollbacks/20261101_x.sql',
      'libs/core/database/src/dev-fixtures.ts',
      'libs/core/i18n/en/shipping.json',
      'docs/IMPLEMENTATION_PLAN.md',
      'scripts/lib/carrier-agnostic.ts'
    ]) {
      expect(isScanned(file)).toBe(false)
    }
  })

  it('leaves out the allowed files, each with its reason', () => {
    expect(Object.keys(ALLOWED_FILES).length).toBeGreaterThan(0)
    for (const [file, reason] of Object.entries(ALLOWED_FILES)) {
      expect(isScanned(file)).toBe(false)
      expect(reason.length).toBeGreaterThan(30)
    }
  })
})

describe('namesCarrier', () => {
  it('knows every carrier of CarrierId by its key and by its distinctive id', () => {
    for (const key of Object.keys(CarrierId)) {
      expect(namesCarrier(`const id = CarrierId.${key}`)).toBe(true)
    }
    expect(namesCarrier("const id = 'forza'")).toBe(true)
    expect(namesCarrier('// C807 signs nothing')).toBe(true)
    expect(namesCarrier('class Forza extends Base {}')).toBe(true)
    expect(namesCarrier('const forzaAdapter = build()')).toBe(true)
    expect(namesCarrier('const c807Client = build()')).toBe(true)
    for (const line of [
      'class C807Client {}',
      'getC807Adapter()',
      'const isForza = 1',
      'useForzaRates()',
      'createLocalCarrier()',
      'isC807(x)'
    ]) {
      expect(namesCarrier(line)).toBe(true)
    }
  })

  it('finds the id that is an ordinary word only when quoted next to a word of shipping', () => {
    expect(namesCarrier('// a `local` courier voids its guide at once')).toBe(true)
    expect(namesCarrier("carrierId: 'local'")).toBe(true)
    expect(namesCarrier("export * from '@platform/carriers/local'")).toBe(true)
    expect(namesCarrier("CarrierId['LOCAL']")).toBe(true)
    expect(namesCarrier("if (shipment.carrierId === 'local') return")).toBe(true)
    expect(namesCarrier("const PRIVATE_TLDS = new Set(['local', 'internal'])")).toBe(false)
    expect(namesCarrier('the local time of the store')).toBe(false)
    expect(namesCarrier('import { localCarrierPlugin } from "x"')).toBe(true)
    expect(namesCarrier('class LocalCourier {}')).toBe(true)
  })

  it('does not take a longer word for a carrier', () => {
    expect(namesCarrier('const reinforza = 1')).toBe(false)
    expect(namesCarrier('const forzaX1 = 1')).toBe(true)
    expect(namesCarrier('id: "9f1c-c807-44aa"')).toBe(false)
    expect(namesCarrier('const getc807 = 1')).toBe(false)
    expect(namesCarrier('const forza2 = 1')).toBe(false)
    expect(namesCarrier('FORZA_ID')).toBe(true)
    expect(namesCarrier('const abc8070 = 1')).toBe(false)
    expect(namesCarrier('CarrierId.UNKNOWN')).toBe(false)
    expect(namesCarrier('const carrier = pickCarrier(connection)')).toBe(false)
  })
})

describe('ORDINARY_WORD_IDS', () => {
  it('lists only ids of CarrierId, and the ids that are ordinary words are decided here, in review', () => {
    expect(Object.values(CarrierId).sort()).toEqual(['c807', 'forza', 'local'])
    expect(ORDINARY_WORD_IDS).toEqual([CarrierId.LOCAL])
  })
})

describe('countReferences', () => {
  it('counts lines, split in code and comments', () => {
    const source = [
      'const id = CarrierId.FORZA; const other = CarrierId.C807 // two names, one line',
      '// a `local` courier',
      '/*',
      ' * Forza and C807',
      ' */',
      'const nothing = 1'
    ].join('\n')
    expect(countReferences(source)).toEqual({ code: 1, comment: 2 })
  })
})

describe('baseline arithmetic (shared with the channel ratchet)', () => {
  it('fails when a count goes up, never when it goes down', () => {
    const baseline = { 'a.ts': { code: 1, comment: 2 } }
    expect(checkAgainstBaseline(baseline, { 'a.ts': { code: 1, comment: 2 } })).toEqual([])
    expect(checkAgainstBaseline(baseline, { 'a.ts': { code: 0, comment: 1 } })).toEqual([])
    expect(checkAgainstBaseline(baseline, { 'a.ts': { code: 2, comment: 2 } })).toHaveLength(1)
    expect(checkAgainstBaseline(baseline, { 'b.ts': { code: 0, comment: 1 } })[0]).toMatchObject({
      file: 'b.ts',
      kind: 'new'
    })
  })

  it('refuses to raise the baseline and writes it only downward', () => {
    const baseline = { 'a.ts': { code: 1, comment: 2 } }
    expect(baselineGrowth(baseline, { 'a.ts': { code: 1, comment: 3 } })).toEqual(['a.ts'])
    expect(() => lowerBaseline(baseline, { 'b.ts': { code: 1, comment: 0 } })).toThrow(
      'the baseline cannot grow'
    )
    expect(lowerBaseline(baseline, { 'a.ts': { code: 0, comment: 1 } })).toEqual({
      'a.ts': { code: 0, comment: 1 }
    })
  })
})
