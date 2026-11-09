import { z } from 'zod'

import { emptyAsUnset, nodeEnvSchema } from '@platform/core/env-rules'

// The toy channel exists for the suites only: it stands for a plugin that a third party wrote, which no file of
// the platform names, so that the e2e can show the web draws a channel from what it declares. Its own variable,
// parsed here, like the plugin of Meta.
export const toyEnvShape = {
  // Only for the e2e and the contract suites; a deployed environment refuses it
  // A variable passed through empty is a variable not set
  E2E_TOY_PLUGIN: emptyAsUnset.refine(value => value === undefined || value === '1', {
    message: 'E2E_TOY_PLUGIN must be 1 when it is set'
  })
}

export const toyEnvSchema = z.object({ NODE_ENV: nodeEnvSchema, ...toyEnvShape }).check(ctx => {
  const env = ctx.value
  if (env.NODE_ENV !== 'test' && env.E2E_TOY_PLUGIN !== undefined) {
    ctx.issues.push({
      code: 'custom',
      message: 'E2E_TOY_PLUGIN is for NODE_ENV=test only: any other environment has no toy channel',
      path: ['E2E_TOY_PLUGIN'],
      input: env.E2E_TOY_PLUGIN
    })
  }
})

export const TOY_ENV_KEYS: readonly string[] = ['NODE_ENV', ...Object.keys(toyEnvShape)]

// Whether the toy channel is registered in this process. Throws in an environment that is not a test one.
export function parseToyEnabled(source: Record<string, string | undefined>): boolean {
  const result = toyEnvSchema.safeParse(source)
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`)
  }
  return result.data.E2E_TOY_PLUGIN === '1'
}

// Whether the toy channel is on in this process, from the validated environment (read when the app is built).
// Loaded when asked and not at the top of the file: this lib is reached from the plugins barrel, and a unit spec
// that loads the barrel has no DATABASE_URL to parse.
export async function isToyChannelEnabled(): Promise<boolean> {
  const { envSource } = await import('@platform/core/config/env')
  return parseToyEnabled(envSource(TOY_ENV_KEYS))
}
