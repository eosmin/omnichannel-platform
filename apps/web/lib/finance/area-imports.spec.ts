import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `area.ts` is read by the navigation of every store screen (`store-nav.tsx`, `store-landing.ts`). Whatever it imports is loaded with the
// orders page and the rest, so it may not pull the settings entries (the organization, account and finance lists) or the finance domain:
// that cost the orders page 6 KB of script and its Lighthouse budget. The family code lives in `family.ts`, for the finance shell only.

// Every way a module is pulled in: `import x from 'm'`, `export * from 'm'`, `export { x } from 'm'`, a bare `import 'm'` and a dynamic
// `import('m')`, with either quote. The gaps are bounded so the scan stays linear on a long file.
const MODULE_REFERENCE =
  /(?:^|\n)[ \t]{0,8}(?:import|export)\b[^;'"]{0,2000}?\bfrom\s{0,20}['"]([^'"\n]{1,300})['"]|(?:^|\n)[ \t]{0,8}import\s{0,20}['"]([^'"\n]{1,300})['"]|\bimport\(\s{0,20}['"]([^'"\n]{1,300})['"]/g

export const modulesOf = (source: string): string[] =>
  [...source.matchAll(MODULE_REFERENCE)].map(match => match[1] ?? match[2] ?? match[3] ?? '')

describe('modulesOf', () => {
  it('sees each form that pulls a module in', () => {
    const forms = [
      "import { a } from 'm1'",
      'import b from "m2"',
      "export * from 'm3'",
      "export { c } from '../m4'",
      "import 'm5'",
      "const d = import('m6')",
      "import type { E } from 'm7'",
      "import {\n  f,\n  g\n} from 'm8'"
    ]
    expect(modulesOf(forms.join('\n'))).toEqual(['m1', 'm2', 'm3', '../m4', 'm5', 'm6', 'm7', 'm8'])
  })

  it('stays fast on a long file with no import', () => {
    const started = Date.now()
    modulesOf(`${'import '.repeat(9000)}\n${'x-'.repeat(9000)}\n${'export '.repeat(5000)}`)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('finance/area.ts', () => {
  const source = readFileSync(join(__dirname, 'area.ts'), 'utf8')

  it('imports nothing but the permissions', () => {
    expect(modulesOf(source)).toEqual(['@platform/core/auth'])
  })
})
