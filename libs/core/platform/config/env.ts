import { parseEnv } from './env-schema'

// The only module of libs/core that reads process.env. Local .env files are loaded by dotenv-flow
// in main.ts before anything imports this; deployed environments inject real variables.
// Never use process.env directly outside this file.
export const env = parseEnv(process.env)
