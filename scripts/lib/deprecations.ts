// Removed or renamed APIs that must not come back (the compat notes of the TDDs, TDD_14 §6).
// Each entry names its replacement, so that the failure tells what to write instead.
export interface DeprecatedApi {
  name: string
  pattern: RegExp
  replacement: string
}

export const DEPRECATED_APIS: readonly DeprecatedApi[] = [
  { name: 'prisma.$use(', pattern: /\.\$use\(/, replacement: '$extends (Prisma 7)' },
  {
    name: 'prisma-client-js',
    pattern: /prisma-client-js/,
    replacement: 'the generator "prisma-client"'
  },
  {
    name: 'datasourceUrl / datasources',
    pattern: /\bdatasourceUrl\s*:|\bdatasources\s*:\s*\{/,
    replacement: 'a driver adapter (PrismaPg)'
  },
  { name: 'z.nativeEnum(', pattern: /\bz\.nativeEnum\(/, replacement: 'z.enum(Enum)' },
  {
    name: 'z.string().url() / .email() / .uuid()',
    pattern: /\bz\.string\(\)\.(url|email|uuid)\(/,
    replacement: 'z.url() / z.email() / z.uuid()'
  },
  { name: 'z.coerce.boolean(', pattern: /\bz\.coerce\.boolean\(/, replacement: 'z.stringbool()' },
  {
    name: 'utcToZonedTime(',
    pattern: /\butcToZonedTime\(/,
    replacement: 'toZonedTime (date-fns-tz v3)'
  },
  { name: "from 'redis'", pattern: /from\s+['"]redis['"]/, replacement: 'ioredis' },
  { name: 'prom-client', pattern: /prom-client/, replacement: '@prometheus-io/client' },
  {
    name: 'useQuery(key, fn)',
    pattern: /\buseQuery\(\s*(?!\{)/,
    replacement: 'the object form: useQuery({ queryKey, queryFn })'
  },
  { name: 'ReactDOM.render(', pattern: /\bReactDOM\.render\(/, replacement: 'createRoot' },
  {
    name: 'ConversationStatusLabels',
    pattern: /\bConversationStatusLabels\b/,
    replacement: 'ConversationStatusI18nKeys'
  },
  {
    name: 'request.query.storeId / request.body.storeId',
    pattern: /\brequest\.(query|body)\.storeId\b/,
    replacement: 'request.store, from TenantGuard (the store never comes from the client)'
  }
]

// Files that are not application code, or that are the list itself
const NOT_SCANNED =
  /(^|\/)(node_modules|dist|generated|coverage|\.next|\.nx|docs)\/|(^|\/)(pnpm-lock\.yaml|scripts\/lib\/deprecations(\.spec)?\.ts)$/
const SCANNED_EXTENSIONS = /\.(ts|tsx|js|cjs|mjs)$|(^|\/)package\.json$/
// A middleware.ts in apps/web is the old name of proxy.ts (Next.js 16)
const WEB_MIDDLEWARE = /^apps\/web\/(.*\/)?middleware\.ts$/

export interface Finding {
  file: string
  line: number
  api: string
  replacement: string
}

export function isScanned(file: string): boolean {
  return !NOT_SCANNED.test(file) && SCANNED_EXTENSIONS.test(file)
}

function isComment(line: string): boolean {
  const text = line.trimStart()
  return text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')
}

export function findDeprecations(file: string, source: string): Finding[] {
  const findings: Finding[] = []
  if (WEB_MIDDLEWARE.test(file)) {
    findings.push({ file, line: 1, api: 'middleware.ts', replacement: 'proxy.ts' })
  }
  if (!isScanned(file)) return findings
  source.split('\n').forEach((text, index) => {
    // A comment may name the old API to explain why it is not used
    if (isComment(text)) return
    for (const api of DEPRECATED_APIS) {
      if (api.pattern.test(text)) {
        findings.push({ file, line: index + 1, api: api.name, replacement: api.replacement })
      }
    }
  })
  return findings
}
