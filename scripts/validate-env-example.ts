import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { ZodType } from 'zod'

import { webEnvSchema } from '../apps/web/lib/env-schema'
import { envSchema } from '../libs/core/platform/config/env-schema'

import { dbRoleEnvSchema } from './db-role-env'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Variables read by tooling, not by the api or the worker: DIRECT_DATABASE_URL by prisma.config.ts
// and the two role passwords by scripts/set-db-role-passwords.ts. They come from that script's own
// schema and are always required.
const TOOLING_KEYS: readonly string[] = Object.keys(dbRoleEnvSchema.shape)

interface Declared {
  key: string
  commented: boolean
}

function declared(path: string): Declared[] {
  const entries: Declared[] = []
  for (const line of readFileSync(`${ROOT}${path}`, 'utf8').split('\n')) {
    const match = /^(#?)\s?([A-Z][A-Z0-9_]*)=/.exec(line)
    if (match?.[2] !== undefined) entries.push({ key: match[2], commented: match[1] === '#' })
  }
  return entries
}

// A key may be commented out only when the schema accepts it missing (optional or defaulted).
function mayBeOmitted(shape: Record<string, ZodType>, key: string): boolean {
  return shape[key]?.safeParse(undefined).success ?? false
}

function compare(
  path: string,
  shape: Record<string, ZodType>,
  toolingKeys: readonly string[]
): string[] {
  const entries = declared(path)
  const expected = [...Object.keys(shape), ...toolingKeys]
  const problems: string[] = []

  for (const key of expected) {
    const entry = entries.find(candidate => candidate.key === key)
    if (entry === undefined) {
      problems.push(`${path}: ${key} is in the schema but not declared`)
    } else if (entry.commented && !mayBeOmitted(shape, key)) {
      problems.push(`${path}: ${key} is required but commented out`)
    }
  }
  const seen = new Set<string>()
  for (const { key } of entries) {
    if (!expected.includes(key)) problems.push(`${path}: ${key} is declared but not in the schema`)
    if (seen.has(key)) problems.push(`${path}: ${key} is declared twice`)
    seen.add(key)
  }
  return problems
}

const problems = [
  ...compare('.env.example', envSchema.shape, TOOLING_KEYS),
  ...compare('apps/web/.env.example', webEnvSchema.shape, [])
]

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('env examples match their schemas')
