import { argv, env, exit } from 'node:process'

import { S3Client } from '@aws-sdk/client-s3'

import { loadBucketEnv } from './bucket-env'
import {
  BUCKET_PROTECTION_MODES,
  endpointHostOf,
  parseBucketProtectionArguments,
  runBucketProtection,
  s3BucketPort
} from './lib/bucket-protection'

// Applies the protection of the production bucket (owner's decision of 2026-11-21, TDD_03 §7.3): versioning on, a lifecycle rule that
// expires the old versions (30 days) and aborts unfinished uploads (7 days). The api and the worker only WATCH this
// (StorageService.inspectProtection); nothing else applies it. Steps, prerequisites and the way back: docs/BUCKET_PROTECTION_RUNBOOK.md.
//
//   pnpm storage:bucket-protection status                          what the bucket has (default; reads only; exit 1 while incomplete)
//   pnpm storage:bucket-protection apply --confirm=<bucket>        versioning on + our lifecycle rule, merged with the rules already there
//   pnpm storage:bucket-protection revert --confirm=<bucket>       removes only our rule; --suspend-versioning also suspends versioning
//   options: --noncurrent-days=30 --abort-multipart-days=7         the periods, editable
//
// The bucket, the endpoint and the credentials come from the ENVIRONMENT of the shell only (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_SESSION_TOKEN when the credentials are temporary, S3_BUCKET, AWS_REGION, S3_ENDPOINT): no .env file is read, nothing is printed
// or written. A mode that changes the bucket runs only with --confirm equal to S3_BUCKET. The bucket and the store of local development
// are refused. PutBucketLifecycleConfiguration replaces every rule of a bucket, so the existing rules are read first and kept; if
// they cannot be read, nothing is written. Idempotent. Exit: 0 done and verified, 1 failed or incomplete, 2 refused.
const parsed = parseBucketProtectionArguments(argv.slice(2))
if ('problem' in parsed) {
  console.error(`${parsed.problem} (modes: ${BUCKET_PROTECTION_MODES.join(', ')})`)
  exit(2)
}

let bucketEnv: ReturnType<typeof loadBucketEnv>
try {
  bucketEnv = loadBucketEnv()
} catch (error) {
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'Invalid environment')
  console.error(
    'Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and S3_BUCKET in the shell (and S3_ENDPOINT for a provider other than AWS).'
  )
  exit(2)
}

const sessionToken = env.AWS_SESSION_TOKEN
const client = new S3Client({
  region: bucketEnv.AWS_REGION,
  credentials: {
    accessKeyId: bucketEnv.AWS_ACCESS_KEY_ID,
    secretAccessKey: bucketEnv.AWS_SECRET_ACCESS_KEY,
    ...(sessionToken === undefined || sessionToken === '' ? {} : { sessionToken })
  },
  ...(bucketEnv.S3_ENDPOINT === undefined ? {} : { endpoint: bucketEnv.S3_ENDPOINT }),
  forcePathStyle: bucketEnv.S3_FORCE_PATH_STYLE,
  // A request that never answers must not hang the operator's session: every call of this command is small
  requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 }
})

const code = await runBucketProtection(
  {
    bucket: bucketEnv.S3_BUCKET,
    region: bucketEnv.AWS_REGION,
    // The host the client really resolved, which also covers an endpoint that the SDK reads from AWS_ENDPOINT_URL* or from the shared
    // config when S3_ENDPOINT is not set. The host only: an endpoint URL may carry a user and a password
    endpointHost:
      endpointHostOf(bucketEnv.S3_ENDPOINT) ?? (await client.config.endpoint?.())?.hostname,
    port: s3BucketPort(client, bucketEnv.S3_BUCKET),
    log: line => console.log(line),
    sleep: ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
  },
  parsed.options
)
client.destroy()
exit(code)
