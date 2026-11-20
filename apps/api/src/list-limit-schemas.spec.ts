import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
  ScriptTarget
} from 'typescript'

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
// The same coercion written by hand: a `z.preprocess` whose callback (its first argument) calls `Number()`, `parseInt()` or `parseFloat()`
// reads '1e2', '0x10' and ' 5' the way the coercion does. Rewriting a value that stays a text (an empty value to undefined, then
// `queryIntSchema`) is fine. Not covered: `.transform(Number)`, unary `+` and `Math.trunc`, and bare `z.number()`, which the bodies of
// the api use on purpose (a text search would have false positives; the per-schema table spec stays Step 7.3)
const HAND_PARSERS = new Set(['Number', 'parseInt', 'parseFloat'])

function coercesByHand(source: string): boolean {
  const file = createSourceFile('source.ts', source, ScriptTarget.Latest, true)
  let found = false
  const callsParser = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      HAND_PARSERS.has(node.expression.text)
    ) {
      found = true
    }
    forEachChild(node, callsParser)
  }
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'z' &&
      node.expression.name.text === 'preprocess' &&
      node.arguments[0] !== undefined
    ) {
      callsParser(node.arguments[0])
    }
    forEachChild(node, visit)
  }
  visit(file)
  return found
}

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
      .filter(path => coercesByHand(readFileSync(join(ROOT, path), 'utf8')))

    expect(offenders).toEqual([])
  })

  // The guard must see what it is for, and leave alone what the finance schemas do today
  it.each([
    ['Number()', 'const a = z.preprocess(value => Number(value), z.number())', true],
    ['parseInt()', 'const a = z.preprocess(v => parseInt(String(v), 10), z.number().int())', true],
    [
      'parseFloat() in a callback with a block and a semicolon',
      'const a = z.preprocess(v => { const n = parseFloat(v as string); return n }, z.number())',
      true
    ],
    [
      'a long callback',
      `const a = z.preprocess(v => {\n${'  // padding\n'.repeat(40)}  return Number(v)\n}, z.number())`,
      true
    ],
    [
      'an empty value rewritten, then digits only',
      "const a = z.preprocess(value => (value === '' ? undefined : value), queryIntSchema(0, 9).optional())",
      false
    ],
    [
      'a text of digits piped to Number',
      "const a = z.preprocess(v => (v === '' ? undefined : v), z.string().regex(/^\\d+$/).transform(Number))",
      false
    ],
    [
      'a Number() call right after, outside the preprocess',
      'const a = z.preprocess(trimEmpty, z.string())\nconst b = z.number().max(Number(LIMIT))',
      false
    ]
  ])('tells %s', (_name, source, caught) => {
    expect(coercesByHand(source)).toBe(caught)
  })
})
