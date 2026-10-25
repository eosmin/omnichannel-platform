import { resolve } from 'node:path'

import { config } from 'dotenv-flow'

const root = resolve(__dirname, '../../../..')

// Importing the http index of the platform parses the env of the app (libs/core/platform/config/env),
// and on a laptop that is satisfied by .env.local while CI has no such file. The suites build their
// own modules and use none of the values, so they get the ones of .env.example, the same base that
// CI uses to start the images. A variable that is already set is never replaced, so the order is
// the priority: the shell, then the laptop's own .env.local, then .env.example for what is missing.
config({ path: root, pattern: '.env.local', silent: true })
config({ path: root, pattern: '.env.example', silent: true })
