// Waits until the bucket of the object storage exists. A SeaweedFS service container answers
// /healthz as soon as the process is up, and creates the bucket from S3_BUCKET a moment later: a
// job that asks /health/ready or uploads in that moment would fail for a reason that has passed by
// the time anybody looks. The values are the ones of .env.example, which the shell can override.
// Usage: tsx scripts/wait-for-bucket.ts
import 'dotenv-flow/config'
import { exit } from 'node:process'

import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'

import { loadBucketEnv } from './bucket-env'

const TIMEOUT_MS = 60_000
const POLL_MS = 1_000
const REQUEST_TIMEOUT_MS = 3_000

const env = loadBucketEnv()
const bucket = env.S3_BUCKET
const client = new S3Client({
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  ...(env.S3_ENDPOINT === undefined ? {} : { endpoint: env.S3_ENDPOINT }),
  forcePathStyle: env.S3_FORCE_PATH_STYLE
})

const deadline = Date.now() + TIMEOUT_MS
let lastError: unknown
for (;;) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    console.log(`the bucket ${bucket} exists`)
    client.destroy()
    break
  } catch (error) {
    lastError = error
  }
  if (Date.now() > deadline) {
    console.error(`the bucket ${bucket} did not appear within 60 seconds:`, lastError)
    exit(1)
  }
  await new Promise(resolveWait => setTimeout(resolveWait, POLL_MS))
}
