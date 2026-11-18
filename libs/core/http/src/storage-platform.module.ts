import { Global, Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { isDeployedEnvironment } from '@platform/core/env-rules'
import { StorageModule } from '@platform/core/storage-module'

import { BUCKET_PROTECTION_CHECK_ENABLED, BucketProtectionCheck } from './bucket-protection.check'

// Object storage, configured from the validated env: SeaweedFS on a laptop and in CI (S3_ENDPOINT,
// path style), S3 or any compatible store in a deployed environment. Global, as the database and
// Redis are: the readiness check, the media endpoints and the worker all need the same client.
@Global()
@Module({
  imports: [
    StorageModule.forRoot({
      bucket: env.S3_BUCKET,
      region: env.AWS_REGION,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE
    })
  ],
  providers: [
    { provide: BUCKET_PROTECTION_CHECK_ENABLED, useValue: isDeployedEnvironment(env.NODE_ENV) },
    BucketProtectionCheck
  ],
  exports: [StorageModule]
})
export class StoragePlatformModule {}
