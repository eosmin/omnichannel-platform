import { config } from 'dotenv-flow'

import { parseEnv } from './env-schema'

// The only module of libs/core that reads process.env. On a laptop dotenv-flow adds the .env.local
// of the working directory first; deployed environments have no such file and inject real
// variables, which always win. Never use process.env directly outside this file.
config({ silent: true })

export const env = parseEnv(process.env)
