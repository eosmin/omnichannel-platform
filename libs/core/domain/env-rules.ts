import { z } from 'zod'

// The rules of an environment that every block of variables is judged by: the core's own and the ones a channel plugin
// parses for itself (`libs/channels/*/src/*-env.ts`). Pure: nothing here reads the environment.
const DEPLOYED_ENVIRONMENTS: readonly string[] = ['staging', 'production']
// What a plugin's own variables are judged against too (see `libs/channels/*/src/*-env.ts`): the plugins compose
// their schema over these instead of copying them
export const nodeEnvSchema = z
  .enum(['development', 'test', 'staging', 'production'])
  .default('development')
export function isDeployedEnvironment(nodeEnv: string): boolean {
  return DEPLOYED_ENVIRONMENTS.includes(nodeEnv)
}
export const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']

// A variable passed through empty (`KEY=${KEY:-}`) is a variable not set
export const emptyAsUnset = z
  .string()
  .optional()
  .transform(value => (value === '' ? undefined : value))

// `new URL` throws on what is not an address; the checks below want a value to ask about
export function urlOrNull(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// A frozen copy of only the keys asked for: what a plugin gets of the environment, never the whole of it
export function pickEnv(
  source: Readonly<Record<string, string | undefined>>,
  keys: readonly string[]
): Readonly<Record<string, string | undefined>> {
  return Object.freeze(Object.fromEntries(keys.map(key => [key, source[key]])))
}
