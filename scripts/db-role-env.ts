import { z } from 'zod'

// The variables of scripts/set-db-role-passwords.ts. They are read by tooling, not by the api
// or the worker, so they live here and not in libs/core/platform/config/env-schema.ts;
// scripts/validate-env-example.ts checks .env.example against this schema.
export const dbRoleEnvSchema = z.object({
  DIRECT_DATABASE_URL: z.url(),
  DB_APP_PASSWORD: z.string().min(12),
  DB_WORKER_PASSWORD: z.string().min(12)
})
export type DbRoleEnv = z.infer<typeof dbRoleEnvSchema>

export function loadDbRoleEnv(): DbRoleEnv {
  const parsed = dbRoleEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
