import { Module } from '@nestjs/common'

import { CryptoPlatformModule, QueuesPlatformModule } from '@platform/core/http'

import { CredentialsResealService } from './credentials-reseal.service'
import { CredentialsResealer } from './credentials-resealer.service'

// The re-seal of the sealed credentials after a rotation of the key (Step 7.3-S11c). It is imported by the module that declares the
// processor of the heavy queue (MediaModule): a provider outside it would bring the image down. The database, the audit and the logger
// are the global modules of the worker.
@Module({
  imports: [CryptoPlatformModule, QueuesPlatformModule],
  providers: [CredentialsResealService, CredentialsResealer],
  exports: [CredentialsResealService, CredentialsResealer]
})
export class CredentialsResealWorkerModule {}
