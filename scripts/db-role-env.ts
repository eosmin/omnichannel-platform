import { z } from 'zod'

// The variables of scripts/set-db-role-passwords.ts. They are read by tooling, not by the api
// or the worker, so they live here and not in libs/core/platform/config/env-schema.ts;
// scripts/validate-env-example.ts checks .env.example against this schema.
export const dbRoleEnvSchema = z.object({
  DIRECT_DATABASE_URL: z.url(),
  DB_APP_PASSWORD: z.string().min(12),
  DB_WORKER_PASSWORD: z.string().min(12),
  // The role of the replica (platform_replica_ro, read only): given a login only where a replica is used
  DB_REPLICA_PASSWORD: z.preprocess(
    value => (value === '' ? undefined : value),
    z.string().min(12).optional()
  )
})
// The password of the pgbouncer role (the auth_user of PgBouncer and the monitoring user of SHOW POOLS):
// docker-compose.yml gives it to Postgres and to PgBouncer, and the pooler suites read it to open the
// admin console. Not the api's: the api only holds the URL of its own role.
export const poolerEnvSchema = z.object({
  PGBOUNCER_AUTH_PASSWORD: z.string().min(12)
})

export type DbRoleEnv = z.infer<typeof dbRoleEnvSchema>

// What scripts/rls-enforce.ts needs: the owner's URL and nothing else (no password of a role)
const ownerEnvSchema = dbRoleEnvSchema.pick({ DIRECT_DATABASE_URL: true })

export function loadOwnerDatabaseUrl(): string | undefined {
  const parsed = ownerEnvSchema.safeParse(process.env)
  return parsed.success ? parsed.data.DIRECT_DATABASE_URL : undefined
}

export function loadDbRoleEnv(): DbRoleEnv {
  const parsed = dbRoleEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

// The environment of the command that gives the worker role its bypass back: `flagProblem` (scripts/lib/rls-worker-role.ts) refuses when
// the flag of the workers is still ON in it
export function workerEnvForRoleScript(): Record<string, string | undefined> {
  return { WORKER_RLS_CONTEXT: process.env['WORKER_RLS_CONTEXT'] }
}
