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
    pattern:
      /\bz\.string\(\)(\s*\.\w+\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))*\s*\.(url|email|uuid)\(/,
    replacement: 'z.url() / z.email() / z.uuid()'
  },
  { name: 'z.coerce.boolean(', pattern: /\bz\.coerce\.boolean\(/, replacement: 'z.stringbool()' },
  {
    name: 'utcToZonedTime(',
    pattern: /\butcToZonedTime\(/,
    replacement: 'toZonedTime (date-fns-tz v3)'
  },
  {
    name: "from 'redis'",
    pattern: /(\bfrom\s+|\brequire\(\s*|\bimport\(\s*|\bimport\s+)['"]redis(\/[^'"]*)?['"]/,
    replacement: 'ioredis'
  },
  { name: 'prom-client', pattern: /prom-client/, replacement: '@prometheus-io/client' },
  {
    name: 'useQuery(key, fn)',
    // The old form takes the key first: a literal, or a variable named key. A first argument that
    // is a call or an options object is the current form
    pattern: /\buse(Suspense|Infinite)?Query(<[^(]*>)?\(\s*(\[|["'`]|\w*[kK]ey\s*,)/,
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
    pattern:
      /\b(request|req)\.(query|body)(\?\.|\.)storeId\b|\b(request|req)\.(query|body)\[\s*['"]storeId['"]|\{[^}]*\bstoreId\b[^}]*\}\s*=\s*(request|req)\.(query|body)\b|@(Body|Query)\(\s*['"]storeId['"]/,
    replacement: 'request.store, from TenantGuard (the store never comes from the client)'
  }
]

// Files that are not application code, or that are the list itself. Build output and
// dependencies at any depth; docs/ and the generated Prisma client only where they live.
const NOT_SCANNED =
  /(^|\/)(node_modules|dist|coverage|\.next|\.nx)\/|^(docs|libs\/core\/database\/generated)\/|(^|\/)(pnpm-lock\.yaml|scripts\/lib\/deprecations(\.spec)?\.ts)$/
const SCANNED_EXTENSIONS = /\.(ts|tsx|js|jsx|cjs|mjs|cts|mts|prisma)$|(^|\/)package\.json$/
// A middleware.ts in apps/web is the old name of proxy.ts (Next.js 16)
const WEB_MIDDLEWARE = /^apps\/web\/(src\/)?middleware\.ts$/

export interface Finding {
  file: string
  line: number
  api: string
  replacement: string
}

export function isScanned(file: string): boolean {
  return !NOT_SCANNED.test(file) && SCANNED_EXTENSIONS.test(file)
}

// The source without its comments, which may name the old API to explain why it is not used. The
// lines stay where they were, so that a finding has the right line. The text of a string is kept
// (a "//" in it is not a comment). A quote ends at the end of its line; a template literal does not.
function withoutComments(source: string): string {
  let out = ''
  let quote: string | undefined
  let comment: 'line' | 'block' | undefined
  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i)
    const next = source.charAt(i + 1)
    if (char === '\n') {
      if (comment === 'line') comment = undefined
      if (quote !== undefined && quote !== '`') quote = undefined
      out += char
    } else if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = undefined
        i++
      }
    } else if (comment === 'line') {
      // dropped until the end of the line
    } else if (quote !== undefined) {
      out += char
      if (char === '\\') {
        out += next
        i++
      } else if (char === quote) {
        quote = undefined
      }
    } else if (char === '\\') {
      // An escaped slash, as in /^https?:\/\//, is not the start of a comment
      out += char + next
      i++
    } else if (char === '/' && next === '/') {
      comment = 'line'
    } else if (char === '/' && next === '*') {
      comment = 'block'
      i++
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char
      out += char
    }
  }
  return out
}

export function findDeprecations(file: string, source: string): Finding[] {
  const findings: Finding[] = []
  if (WEB_MIDDLEWARE.test(file)) {
    findings.push({ file, line: 1, api: 'middleware.ts', replacement: 'proxy.ts' })
  }
  if (!isScanned(file)) return findings
  // Over the whole text, so that a call that Prettier broke over several lines is still seen
  const code = withoutComments(source)
  for (const api of DEPRECATED_APIS) {
    for (const match of code.matchAll(new RegExp(api.pattern.source, 'g'))) {
      const line = code.slice(0, match.index).split('\n').length
      findings.push({ file, line, api: api.name, replacement: api.replacement })
    }
  }
  findings.sort((a, b) => a.line - b.line)
  return findings
}
