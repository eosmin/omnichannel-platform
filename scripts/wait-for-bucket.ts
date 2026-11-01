// Waits until the bucket of the object storage exists. A SeaweedFS service container answers
// /healthz as soon as the process is up, and creates the bucket from S3_BUCKET a moment later: a
// job that asks /health/ready or uploads in that moment would fail for a reason that has passed by
// the time anybody looks. The values are the ones of .env.local if there is one, then .env.example
// (as the test suites do); a variable already set in the shell is never replaced.
// Usage: tsx scripts/wait-for-bucket.ts
import { resolve } from 'node:path'
import { exit } from 'node:process'

import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { config } from 'dotenv-flow'

import { loadBucketEnv } from './bucket-env'

config({ path: resolve(import.meta.dirname, '..'), pattern: '.env.local', silent: true })
config({ path: resolve(import.meta.dirname, '..'), pattern: '.env.example', silent: true })

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
let lastReason = ''
for (;;) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    console.log(`the bucket ${bucket} exists`)
    client.destroy()
    break
  } catch (error) {
    // Every distinct answer is shown once: a wrong key or endpoint says so at once, instead of
    // looking like a bucket that is just late
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (reason !== lastReason) console.log(`waiting for the bucket ${bucket}: ${reason}`)
    lastReason = reason
  }
  if (Date.now() > deadline) {
    console.error(`the bucket ${bucket} did not appear within ${TIMEOUT_MS / 1000} seconds`)
    client.destroy()
    exit(1)
  }
  await new Promise(resolveWait => setTimeout(resolveWait, POLL_MS))
}
