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
const COERCED_NUMBER = /\bcoerce\s*\.\s*number\b/
// The same coercion written by hand: a `z.preprocess` whose callback turns the text into a number with `Number()`, `parseInt()` or
// `parseFloat()` reads '1e2', '0x10' and ' 5' the way the coercion does. Rewriting a value that stays a text (an empty value to
// undefined, then `queryIntSchema`) is fine and does not match. Bare `z.number()` is not searched: the bodies of the api use it on purpose
const HAND_COERCED_NUMBER =
  /\bz\s*\.\s*preprocess\s*\([^;]{0,240}?\b(?:Number|parseInt|parseFloat)\s*\(/

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

  it('are never turned into a number by hand inside a z.preprocess', () => {
    const offenders = SCANNED.flatMap(dir => sources(join(ROOT, dir)))
      .map(path => relative(ROOT, path))
      .filter(path => !ALLOWED.has(path))
      .filter(path => HAND_COERCED_NUMBER.test(readFileSync(join(ROOT, path), 'utf8')))

    expect(offenders).toEqual([])
  })

  // The guard must see what it is for, and leave alone what the finance schemas do today
  it.each([
    ['Number()', 'z.preprocess(value => Number(value), z.number())', true],
    ['parseInt()', 'z.preprocess(v => parseInt(String(v), 10), z.number().int())', true],
    ['parseFloat()', 'z.preprocess(\n  v => parseFloat(v as string),\n  z.number()\n)', true],
    [
      'an empty value rewritten, then digits only',
      "z.preprocess(value => (value === '' ? undefined : value), queryIntSchema(0, 9).optional())",
      false
    ],
    [
      'a text of digits piped to Number',
      "z.preprocess(v => (v === '' ? undefined : v), z.string().regex(/^\\d+$/).transform(Number))",
      false
    ]
  ])('tells %s', (_name, source, caught) => {
    expect(HAND_COERCED_NUMBER.test(source)).toBe(caught)
  })
})
