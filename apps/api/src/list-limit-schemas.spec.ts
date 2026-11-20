import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// QA RB-G4 (debt of #672): `z.coerce.number()` reads '1e2' as 100, '0x10' as 16, ' 5' as 5 and '5.0' as 5, so a page size no screen
// sends passed as a number. Every whole number of a query string (a page size, a number of days) is read with `queryIntSchema`
// (decimal digits and nothing else). This spec fails when a query schema of the api or of the core goes back to the coercion.
const ROOT = resolve(__dirname, '../../..')
const SCANNED = ['apps/api/src', 'libs/core']
// Not a query string: the environment of the process reads its numbers on purpose, and `validation.ts` explains the rule in a comment
const ALLOWED = new Set([
  'libs/core/platform/config/env-schema.ts',
  'libs/core/domain/validation.ts'
])
const COERCED_NUMBER = /z\s*\.coerce\s*\.number\(\)/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (name === 'node_modules' || name === 'generated') return []
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('the whole numbers of a query string', () => {
  it('are never read with z.coerce.number()', () => {
    const offenders = SCANNED.flatMap(dir => sources(join(ROOT, dir)))
      .map(path => relative(ROOT, path))
      .filter(path => !ALLOWED.has(path))
      .filter(path => COERCED_NUMBER.test(readFileSync(join(ROOT, path), 'utf8')))

    expect(offenders).toEqual([])
  })
})
