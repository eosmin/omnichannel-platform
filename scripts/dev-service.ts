import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { config } from 'dotenv-flow'

import { DevService, type DevServiceName, devServiceEnv } from './lib/dev-services'

// Runs one built service (dist/apps/<name>) and restarts it when the build is rewritten, so that
// `nest build --watch` beside it gives the loop of a dev server. Used by the `serve` targets of the
// api and the worker (`pnpm dev`). It starts only the process it is asked for and stops when it is
// stopped: it never looks for, signals or replaces a process it did not start.
// Usage: tsx scripts/dev-service.ts <api|worker>
const root = resolve(import.meta.dirname, '..')
const name = process.argv[2]
if (name !== DevService.API && name !== DevService.WORKER) {
  throw new Error(`usage: dev-service.ts <${DevService.API}|${DevService.WORKER}>`)
}
const service: DevServiceName = name

// The laptop's .env.local first, then .env.example for what is missing; a variable already set is
// never replaced, so the shell wins
config({ path: root, pattern: '.env.local', silent: true })
config({ path: root, pattern: '.env.example', silent: true })

const directory = resolve(root, 'dist', 'apps', service)
const child = spawn(
  process.execPath,
  [`--watch-path=${directory}`, '--watch-preserve-output', resolve(directory, 'main.js')],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ...devServiceEnv(service, process.env) } }
)
child.on('exit', code => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => child.kill(signal))
}
