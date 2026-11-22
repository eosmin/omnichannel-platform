import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

// The indirect reach of @TenantOfOrganizationStores. A controller marked with it runs its whole request in a context that holds EVERY store
// of the organization. A service it reaches that opens `JobContext.forStoreOrJoin` is refused there (`JobContextError`: the work of one store
// must not read and write across all of them), so the route would fail at runtime, late and only on the path that reaches it. This spec reads the
// imports instead: it follows, from each marked controller, the symbols it imports (through the barrels, to the file that defines each
// one) and fails when any file it can reach calls `forStoreOrJoin`. `inOrganizationOrRequest` is not flagged: it joins a context that holds the
// organization, which is what these routes have.
// Its limit, stated in the plan: it follows static imports only, so reach through an `@OnEvent` listener, a queue processor or a dynamic
// import is not seen. A symbol it cannot place makes it take the whole file it was imported from (more reach, never less), and a specifier of
// the repository that it cannot resolve fails the spec.
const ROOT = join(__dirname, '../../../../..')
const MARK = '@TenantOfOrganizationStores('

const paths = (
  JSON.parse(readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> }
  }
).compilerOptions.paths

// A call through an instance, with or without type arguments and with a line break before the parenthesis. The declaration of the method
// has no dot before its name, so it is not a call; a method of JobContext that delegates with `this.forStoreOrJoin(` is.
const NARROW_CALL = /\.forStoreOrJoin\s*(?:<[^()]*>)?\s*\(/

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function callsNarrowContext(text: string): boolean {
  return NARROW_CALL.test(withoutComments(text))
}

function resolveSpecifier(from: string, specifier: string): string | undefined {
  const isRepositorySpecifier = specifier.startsWith('.') || specifier.startsWith('@platform/')
  if (!isRepositorySpecifier) return undefined
  // The generated Prisma client is output of a tool (absent until `prisma generate` runs) and holds no JobContext call
  if (specifier.includes('/generated/')) return undefined
  const base = specifier.startsWith('.') ? join(dirname(from), specifier) : paths[specifier]?.[0]
  if (base !== undefined) {
    const absolute = base.startsWith('/') ? base : join(ROOT, base)
    for (const candidate of [`${absolute}.ts`, absolute, join(absolute, 'index.ts')]) {
      if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate
    }
  }
  throw new Error(`the specifier ${specifier} of ${from} cannot be resolved by the reach spec`)
}

interface Reference {
  specifier: string
  // `null` for `export *`, a default import and a namespace import: every symbol of the target is taken
  names: { exported: string; original: string }[] | null
}

// The static imports and the re-exports of a file (type-only ones carry no behaviour and are skipped)
function referencesOf(text: string): { imports: Reference[]; reexports: Reference[] } {
  const imports: Reference[] = []
  const reexports: Reference[] = []
  const statement =
    /(import|export)\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*(?:\s+as\s+[\w$]+)?)?\s*from\s*'([^']+)'/g
  for (const match of withoutComments(text).matchAll(statement)) {
    const [, kind, isType, defaultName, braces, specifier] = match
    if (isType !== undefined || specifier === undefined) continue
    const names =
      braces === undefined || defaultName !== undefined
        ? null
        : braces
            .split(',')
            .map(part => part.trim())
            .filter(part => part !== '' && !part.startsWith('type '))
            .map(part => {
              const [original = '', exported = original] = part.split(/\s+as\s+/).map(s => s.trim())
              return { exported, original }
            })
    const reference: Reference = { specifier, names }
    if (kind === 'import') imports.push(reference)
    else reexports.push(reference)
  }
  return { imports, reexports }
}

function definesSymbol(text: string, name: string): boolean {
  const escaped = name.replace(/\$/g, '\\$')
  const declared = new RegExp(
    `export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:class|const|function\\*?|enum|let|var|namespace|interface|type)\\s+${escaped}\\b`
  )
  // `export { name }` / `export { other as name }` of something declared in the file (no `from`)
  const listed = new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}(?!\\s*from)`)
  const clean = withoutComments(text)
  return declared.test(clean) || listed.test(clean)
}

// Every file whose code the entry can run: the file that defines each imported symbol, and then everything that file imports
function reachableFrom(entry: string): Set<string> {
  const taken = new Set<string>()
  const visited = new Set<string>()

  const takeFile = (file: string): void => {
    if (taken.has(file)) return
    taken.add(file)
    for (const reference of referencesOf(readFileSync(file, 'utf8')).imports)
      follow(file, reference)
  }

  const follow = (from: string, reference: Reference): void => {
    const target = resolveSpecifier(from, reference.specifier)
    if (target === undefined || target.endsWith('.spec.ts')) return
    if (reference.names === null) {
      lookUp(target, '*')
      return
    }
    for (const { original } of reference.names) {
      // A symbol that no file can be shown to define: the file is taken as a whole, so the reach is over-counted and never missed
      if (!lookUp(target, original)) takeFile(target)
    }
  }

  // True when the symbol was placed in a file that was taken
  const lookUp = (file: string, name: string): boolean => {
    const key = `${file}#${name}`
    if (visited.has(key)) return true
    visited.add(key)
    const text = readFileSync(file, 'utf8')
    let placed = false
    if (name === '*' || definesSymbol(text, name)) {
      takeFile(file)
      placed = true
    }
    // A barrel hands the symbol on: follow the re-exports that can carry it, under the name it has in the target
    for (const reexport of referencesOf(text).reexports) {
      const target = resolveSpecifier(file, reexport.specifier)
      if (target === undefined || target.endsWith('.spec.ts')) continue
      if (reexport.names === null || name === '*') {
        placed = lookUp(target, name) || placed
        continue
      }
      for (const { exported, original } of reexport.names) {
        if (exported === name) placed = lookUp(target, original) || placed
      }
    }
    return placed
  }

  takeFile(entry)
  return taken
}

function markedControllers(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.controller.ts') && readFileSync(path, 'utf8').includes(MARK)) {
        found.push(relative(ROOT, path))
      }
    }
  }
  walk(join(ROOT, 'apps/api/src'))
  return found.sort()
}

describe('the detector of the narrow call', () => {
  it.each([
    ['a plain call', 'await this.jobs.forStoreOrJoin(storeId, () => work())'],
    ['a call with type arguments', 'this.jobs.forStoreOrJoin<Result>(storeId, () => work())'],
    [
      'a call with a line break before the parenthesis',
      'this.jobs.forStoreOrJoin\n  (storeId, fn)'
    ],
    ['a delegation inside the context class', 'return this.forStoreOrJoin(id, work)']
  ])('flags %s', (_name, source) => {
    expect(callsNarrowContext(source)).toBe(true)
  })

  it.each([
    [
      'the declaration of the method',
      'forStoreOrJoin<T>(\n storeId: string,\n work: () => Promise<T>\n): Promise<T> {'
    ],
    ['a line comment', '// the service used to call this.jobs.forStoreOrJoin(storeId, fn)'],
    ['a block comment', '/* this.jobs.forStoreOrJoin(storeId, fn) */ const a = 1'],
    ['the call that joins an organization context', 'this.jobs.inOrganizationOrRequest(id, fn)']
  ])('does not flag %s', (_name, source) => {
    expect(callsNarrowContext(source)).toBe(false)
  })
})

describe('the walk of the imports', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'reach-spec-'))
    writeFileSync(
      join(dir, 'controller.ts'),
      `import { reopen } from './barrel'\nimport { harmless } from './harmless'\nexport class C { run() { return [reopen, harmless] } }\n`
    )
    writeFileSync(join(dir, 'barrel.ts'), `export { inner as reopen } from './inner'\n`)
    writeFileSync(
      join(dir, 'inner.ts'),
      `export async function inner(jobs: any) { return jobs.forStoreOrJoin<number>('s', async () => 1) }\n`
    )
    writeFileSync(join(dir, 'harmless.ts'), `export const harmless = 1\n`)
    writeFileSync(join(dir, 'unrelated.ts'), `export const x = jobs.forStoreOrJoin('s', f)\n`)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reaches a function declared async behind a barrel that renames it, and not a file nobody imports', () => {
    const reached = [...reachableFrom(join(dir, 'controller.ts'))].map(file => relative(dir, file))
    // The barrel only hands the symbol on: the file that defines it is the one taken
    expect(reached.sort()).toEqual(['controller.ts', 'harmless.ts', 'inner.ts'])
    expect(
      [...reachableFrom(join(dir, 'controller.ts'))].filter(file =>
        callsNarrowContext(readFileSync(file, 'utf8'))
      )
    ).toEqual([join(dir, 'inner.ts')])
  })

  it('fails on a specifier of the repository that it cannot resolve', () => {
    writeFileSync(join(dir, 'broken.ts'), `import { a } from './missing'\nexport const b = a\n`)
    expect(() => reachableFrom(join(dir, 'broken.ts'))).toThrow(/cannot be resolved/)
  })

  it('reaches the libraries by alias from a real controller (the walk is not blind to them)', () => {
    const reached = [
      ...reachableFrom(join(ROOT, 'apps/api/src/modules/transfers/transfers.controller.ts'))
    ].map(file => relative(ROOT, file))
    expect(reached.some(file => file.startsWith('apps/api/src/modules/transfers/'))).toBe(true)
    expect(reached.some(file => file.startsWith('libs/core/database/'))).toBe(true)
  })
})

describe('the indirect reach of @TenantOfOrganizationStores', () => {
  const controllers = markedControllers()

  it('has marked controllers to check (the scan did not come back empty)', () => {
    expect(controllers.length).toBeGreaterThanOrEqual(4)
  })

  it.each(controllers)('no code reached from %s opens the context of one store', controller => {
    const calling = [...reachableFrom(join(ROOT, controller))]
      .filter(file => callsNarrowContext(readFileSync(file, 'utf8')))
      .map(file => relative(ROOT, file))
      .sort()
    expect(calling).toEqual([])
  })
})
