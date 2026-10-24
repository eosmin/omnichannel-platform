import { DEPRECATED_APIS, findDeprecations, isScanned } from './deprecations'

const names = (source: string, file = 'libs/core/x/service.ts'): string[] =>
  findDeprecations(file, source).map(finding => finding.api)

describe('findDeprecations', () => {
  it('finds each removed API with the replacement to write', () => {
    const cases: [string, string][] = [
      ['client.$use(middleware)', 'prisma.$use('],
      ['generator client { provider = "prisma-client-js" }', 'prisma-client-js'],
      ['new PrismaClient({ datasourceUrl: url })', 'datasourceUrl / datasources'],
      ['new PrismaClient({ datasources: { db: {} } })', 'datasourceUrl / datasources'],
      ['z.nativeEnum(Status)', 'z.nativeEnum('],
      ['z.string().url()', 'z.string().url() / .email() / .uuid()'],
      ['z.string().email()', 'z.string().url() / .email() / .uuid()'],
      ['z.coerce.boolean()', 'z.coerce.boolean('],
      ['utcToZonedTime(date, zone)', 'utcToZonedTime('],
      ["import { createClient } from 'redis'", "from 'redis'"],
      ["import client from 'prom-client'", 'prom-client'],
      ['useQuery(key, fetchOrders)', 'useQuery(key, fn)'],
      ['ReactDOM.render(<App />, root)', 'ReactDOM.render('],
      ['ConversationStatusLabels[status]', 'ConversationStatusLabels'],
      ['const id = request.query.storeId', 'request.query.storeId / request.body.storeId'],
      ['const id = request.body.storeId', 'request.query.storeId / request.body.storeId']
    ]
    for (const [source, expected] of cases) expect(names(source)).toContain(expected)
    expect(DEPRECATED_APIS.every(api => api.replacement.length > 0)).toBe(true)
  })

  it('accepts the current forms', () => {
    const current = [
      "z.enum(['a', 'b'])",
      'z.url()',
      'z.stringbool()',
      'toZonedTime(date, zone)',
      "import Redis from 'ioredis'",
      "import { Counter } from '@prometheus-io/client'",
      'useQuery({ queryKey: [], queryFn })',
      'createRoot(root).render(<App />)',
      'ConversationStatusI18nKeys[status]',
      'const id = request.store.id'
    ]
    for (const source of current) expect(names(source)).toEqual([])
  })

  it('does not take a comment for a use, and reports the line of a real one', () => {
    const source = [
      '// prom-client is deprecated',
      ' * z.nativeEnum( is gone',
      'z.nativeEnum(Status)'
    ].join('\n')
    expect(findDeprecations('libs/x.ts', source)).toEqual([
      expect.objectContaining({ line: 3, api: 'z.nativeEnum(' })
    ])
  })

  it('refuses a middleware.ts in apps/web, the old name of proxy.ts', () => {
    expect(names('export {}', 'apps/web/middleware.ts')).toEqual(['middleware.ts'])
    expect(names('export {}', 'apps/web/src/middleware.ts')).toEqual(['middleware.ts'])
    expect(names('export {}', 'apps/api/src/middleware.ts')).toEqual([])
  })
})

describe('isScanned', () => {
  it('scans the source and package.json, and skips what is not ours', () => {
    expect(isScanned('libs/core/http/src/sentry.ts')).toBe(true)
    expect(isScanned('package.json')).toBe(true)
    expect(isScanned('apps/api/rspack.config.cjs')).toBe(true)
    for (const file of [
      'docs/TDD_01_Architecture.md',
      'pnpm-lock.yaml',
      'node_modules/x/index.js',
      'libs/core/database/generated/client/client.ts',
      'scripts/lib/deprecations.ts',
      'scripts/lib/deprecations.spec.ts',
      'README.md'
    ]) {
      expect(isScanned(file)).toBe(false)
    }
  })
})
