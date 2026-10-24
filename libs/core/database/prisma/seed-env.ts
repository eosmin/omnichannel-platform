import 'dotenv-flow/config'
import { z } from 'zod'

// The variables of the two database scripts (seed.ts and dev-fixtures.ts). Read only here.
const connection = z.object({ DIRECT_DATABASE_URL: z.url() })

export const bootstrapEnvSchema = connection.extend({
  SEED_OWNER_EMAIL: z.email(),
  SEED_OWNER_NAME: z.string().min(1).optional(),
  SEED_ORGANIZATION_NAME: z.string().min(1),
  SEED_STORE_NAME: z.string().min(1)
})

export const fixturesEnvSchema = connection.extend({
  // No default: a shell that forgot NODE_ENV must not be taken for a development one
  NODE_ENV: z.enum(['development', 'test']),
  CREDENTIALS_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/)
})

export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}
