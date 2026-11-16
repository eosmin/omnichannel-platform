import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'

import { FiscalDocumentsService } from './fiscal-documents.service'
import { FiscalIssuerService } from './fiscal-issuer.service'
import { FISCAL_PROVIDERS, FiscalProviderRegistry } from './fiscal-provider.registry'
import { officialFiscalProviders } from './official-providers'

// The fiscal documents of the organization for the api and for the worker: the providers this deployment has, the issuer and the
// lifecycle of a document. It relies on the global database, audit and event-bus modules of the app.
@Module({
  imports: [CryptoPlatformModule],
  providers: [
    {
      provide: FISCAL_PROVIDERS,
      // The validated environment of the app (loaded when the module is built, never by a unit spec that only reads the rules)
      useFactory: async () => {
        const { env } = await import('@platform/core/config/env')
        return officialFiscalProviders(env.NODE_ENV)
      }
    },
    FiscalProviderRegistry,
    FiscalIssuerService,
    FiscalDocumentsService
  ],
  exports: [FiscalDocumentsService, FiscalIssuerService, FiscalProviderRegistry]
})
export class FiscalRuntimeModule {}
