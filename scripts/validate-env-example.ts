import { readFileSync } from 'node:fs'

import { envSchema } from '../libs/core/config/env-schema'
import { webEnvSchema } from '../apps/web/lib/env-schema'

// Variables read by tooling, not by the api or the worker: DIRECT_DATABASE_URL by prisma.config.ts
// and the two role passwords by the role script of Step 0.4. Step 0.4 replaces this list with the
// keys of that script's own Zod schema.
const TOOLING_KEYS: readonly string[] = [
  'DIRECT_DATABASE_URL',
  'DB_APP_PASSWORD',
  'DB_WORKER_PASSWORD'
]

// A commented-out optional variable ("# KEY=") counts as present.
function declaredKeys(path: string): string[] {
  const keys: string[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(line)
    if (match?.[1] !== undefined) keys.push(match[1])
  }
  return keys
}

function compare(path: string, expected: readonly string[]): string[] {
  const declared = declaredKeys(path)
  const problems: string[] = []
  for (const key of expected) {
    if (!declared.includes(key)) problems.push(`${path}: ${key} is in the schema but not declared`)
  }
  for (const key of declared) {
    if (!expected.includes(key)) problems.push(`${path}: ${key} is declared but not in the schema`)
  }
  const seen = new Set<string>()
  for (const key of declared) {
    if (seen.has(key)) problems.push(`${path}: ${key} is declared twice`)
    seen.add(key)
  }
  return problems
}

const problems = [
  ...compare('.env.example', [...Object.keys(envSchema.shape), ...TOOLING_KEYS]),
  ...compare('apps/web/.env.example', Object.keys(webEnvSchema.shape))
]

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('env examples match their schemas')
