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
      [
        "import { Html } from '@react-email/components'",
        '@react-email/components, @react-email/render'
      ],
      [
        "import { render } from '@react-email/render'",
        '@react-email/components, @react-email/render'
      ],
      ['useQuery(key, fetchOrders)', 'useQuery(key, fn)'],
      ['ReactDOM.render(<App />, root)', 'ReactDOM.render('],
      ['ConversationStatusLabels[status]', 'ConversationStatusLabels'],
      ['const id = request.query.storeId', 'request.query.storeId / request.body.storeId'],
      ['const id = request.body.storeId', 'request.query.storeId / request.body.storeId'],
      ['const id = req.body.storeId', 'request.query.storeId / request.body.storeId'],
      ["list(@Query('storeId') id: string)", 'request.query.storeId / request.body.storeId'],
      ['create(@Body("storeId") id: string)', 'request.query.storeId / request.body.storeId'],
      ['const id = request.body?.storeId', 'request.query.storeId / request.body.storeId'],
      ["const id = request.query['storeId']", 'request.query.storeId / request.body.storeId'],
      ['const { storeId } = request.body', 'request.query.storeId / request.body.storeId'],
      ['const { name, storeId } = req.query', 'request.query.storeId / request.body.storeId'],
      ["useQuery(['orders'], fetchOrders)", 'useQuery(key, fn)'],
      ["useQuery<Order[]>(['orders'], fetchOrders)", 'useQuery(key, fn)'],
      ['z.string().trim().email()', 'z.string().url() / .email() / .uuid()'],
      ['z.string().min(1).max(40).uuid()', 'z.string().url() / .email() / .uuid()'],
      ['z.string().transform(v => v.trim()).email()', 'z.string().url() / .email() / .uuid()'],
      ['z.string().transform(v => f(g(v))).email()', 'z.string().url() / .email() / .uuid()'],
      ['z.string().regex(/^(a|b)$/).uuid()', 'z.string().url() / .email() / .uuid()'],
      ['z.string()\n  .trim()\n  .email()', 'z.string().url() / .email() / .uuid()'],
      ["useQuery(\n  ['orders', id],\n  fetchOrders\n)", 'useQuery(key, fn)'],
      ["useInfiniteQuery(['orders'], fetchPage)", 'useQuery(key, fn)'],
      ["const { createClient } = require('redis')", "from 'redis'"],
      ["const redis = await import('redis')", "from 'redis'"],
      ["import { x } from 'redis/dist/index'", "from 'redis'"],
      ["import 'redis'", "from 'redis'"]
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
      'useQuery( { queryKey: [], queryFn })',
      'const query = useQuery(',
      'useQuery(orderQueryOptions(id))',
      'useQuery(options, queryClient)',
      'z.string().min(1)',
      'const { name } = request.body',
      "import Redis from 'ioredis'",
      '{"ioredis": "^5.0.0"}',
      'const health = { "redis": "up" }',
      'createRoot(root).render(<App />)',
      'ConversationStatusI18nKeys[status]',
      'const id = request.store.id'
    ]
    for (const source of current) expect(names(source)).toEqual([])
  })

  it('does not take a comment for a use, and reports the line of a real one', () => {
    const source = [
      '// prom-client is deprecated',
      '/**',
      ' * z.nativeEnum( is gone',
      ' */',
      'z.nativeEnum(Status)'
    ].join('\n')
    expect(findDeprecations('libs/x.ts', source)).toEqual([
      expect.objectContaining({ line: 5, api: 'z.nativeEnum(' })
    ])
  })

  it('takes a JSX comment and a comment right after a bracket for comments', () => {
    const source = ['{/* z.nativeEnum( was removed */}', 'call(/* z.nativeEnum( */ a)'].join('\n')
    expect(findDeprecations('apps/web/x.tsx', source)).toEqual([])
  })

  it('tells a comment from the text of a string', () => {
    const source = [
      "const msg = 'see // docs'; z.nativeEnum(Status)",
      "const open = 'x /* y'; z.nativeEnum(Other)",
      'foo();// z.nativeEnum( was removed',
      'const url = "http://example.com"; z.nativeEnum(Last)',
      'const t = `a // b',
      '`; z.nativeEnum(Template)'
    ].join('\n')
    expect(findDeprecations('libs/x.ts', source).map(finding => finding.line)).toEqual([1, 2, 4, 6])
  })

  it('does not take the end of a regex literal for a comment', () => {
    const source = 'const ok = /^https?:\\/\\//.test(x) && z.nativeEnum(Status)'
    expect(names(source)).toEqual(['z.nativeEnum('])
  })

  it('keeps looking after a block comment, and skips only the comment', () => {
    const source = [
      '/*',
      'z.nativeEnum( in prose, with no star on the line',
      '*/ z.nativeEnum(Status)',
      'const a = 1 // z.nativeEnum(',
      'const glob = "libs/*/src"; z.nativeEnum(Status)',
      '  * rate',
      'z.nativeEnum(Other)'
    ].join('\n')
    expect(findDeprecations('libs/x.ts', source).map(finding => finding.line)).toEqual([3, 5, 7])
  })

  it('refuses a middleware.ts in apps/web, the old name of proxy.ts', () => {
    expect(names('export {}', 'apps/web/middleware.ts')).toEqual(['middleware.ts'])
    expect(names('export {}', 'apps/web/src/middleware.ts')).toEqual(['middleware.ts'])
    expect(names('export {}', 'apps/api/src/middleware.ts')).toEqual([])
    expect(names('export {}', 'apps/web/lib/auth/middleware.ts')).toEqual([])
  })
})

describe('isScanned', () => {
  it('scans the source and package.json, and skips what is not ours', () => {
    expect(isScanned('libs/core/http/src/sentry.ts')).toBe(true)
    expect(isScanned('package.json')).toBe(true)
    expect(isScanned('apps/api/rspack.config.cjs')).toBe(true)
    for (const extension of ['jsx', 'mts', 'cts']) {
      expect(isScanned(`libs/x/src/file.${extension}`)).toBe(true)
    }
    expect(isScanned('libs/core/database/prisma/schema.prisma')).toBe(true)
    expect(isScanned('apps/web/app/[locale]/docs/page.tsx')).toBe(true)
    expect(isScanned('libs/feature/src/generated/mapper.ts')).toBe(true)
    for (const file of [
      'docs/TDD_01_Architecture.md',
      'pnpm-lock.yaml',
      'node_modules/x/index.js',
      'libs/core/database/generated/client/client.ts',
      'scripts/lib/deprecations.ts',
      'scripts/lib/deprecations.spec.ts',
      'apps/api/dist/main.js',
      'README.md'
    ]) {
      expect(isScanned(file)).toBe(false)
    }
  })
})
