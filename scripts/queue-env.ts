import { z } from 'zod'

// How the worker names its queues (QUEUE_PREFIX, or the name of DATABASE_URL), read by the scripts that
// put a job in them. Same keys as env-schema.ts.
const queueEnvSchema = z.object({
  QUEUE_PREFIX: z.string().optional(),
  DATABASE_URL: z.url().optional()
})
export type QueueEnv = z.infer<typeof queueEnvSchema>

export function loadQueueEnv(): QueueEnv {
  const parsed = queueEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
