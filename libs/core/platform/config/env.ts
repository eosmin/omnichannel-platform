import { config } from 'dotenv-flow'

import { pickEnv } from '@platform/core/env-rules'

import { parseEnv } from './env-schema'

// The only module of libs/core that reads process.env. On a laptop dotenv-flow adds the .env.local
// of the working directory first; deployed environments have no such file and inject real
// variables, which always win. Never use process.env directly outside this file.
config({ silent: true })

export const env = parseEnv(process.env)

// The variables as this module loaded them (the laptop's .env files included), for a plugin that validates its own
// block with its own schema: libs/core cannot import a plugin, so the plugin asks for its keys and parses them. A
// frozen copy of ONLY the keys asked for: a plugin (a third party's too) never holds the secrets of the core.
export function envSource(keys: readonly string[]): Readonly<Record<string, string | undefined>> {
  return pickEnv(process.env, keys)
}
