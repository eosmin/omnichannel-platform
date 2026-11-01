import { z } from 'zod'

// The variables of scripts/wait-for-bucket.ts: the storage ones of the api, read by tooling that
// must not load the whole env of the api. Same keys and defaults as env-schema.ts.
export const bucketEnvSchema = z.object({
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET: z.string(),
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false)
})
export type BucketEnv = z.infer<typeof bucketEnvSchema>

export function loadBucketEnv(): BucketEnv {
  const parsed = bucketEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}
