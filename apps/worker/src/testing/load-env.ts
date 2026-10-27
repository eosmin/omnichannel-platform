import { resolve } from 'node:path'

import { config } from 'dotenv-flow'

// Runs before any integration suite of the worker (jest setupFiles), because the platform reads and
// validates its env when it is imported. The same base as the suites of the api: the laptop's
// .env.local, then .env.example for what is missing. A variable that is already set is never
// replaced, so the shell and CI win over both.
config({ path: resolve(__dirname, '../../../..'), pattern: '.env.local', silent: true })
config({ path: resolve(__dirname, '../../../..'), pattern: '.env.example', silent: true })
