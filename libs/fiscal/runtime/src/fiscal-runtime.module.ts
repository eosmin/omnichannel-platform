import { Module } from '@nestjs/common'

import {
  CryptoPlatformModule,
  RUNTIME_ENVIRONMENT,
  RuntimeEnvironmentPlatformModule
} from '@platform/core/http'

import { FiscalDocumentsService } from './fiscal-documents.service'
import { FiscalIssuerService } from './fiscal-issuer.service'
import { FISCAL_PROVIDERS, FiscalProviderRegistry } from './fiscal-provider.registry'
import { officialFiscalProviders } from './official-providers'

// The fiscal documents of the organization for the api and for the worker: the providers this deployment has, the issuer and the
// lifecycle of a document. It relies on the global database, audit and event-bus modules of the app.
@Module({
  imports: [CryptoPlatformModule, RuntimeEnvironmentPlatformModule],
  providers: [
    {
      provide: FISCAL_PROVIDERS,
      inject: [RUNTIME_ENVIRONMENT],
      useFactory: (nodeEnv: string) => officialFiscalProviders(nodeEnv)
    },
    FiscalProviderRegistry,
    FiscalIssuerService,
    FiscalDocumentsService
  ],
  exports: [FiscalDocumentsService, FiscalIssuerService, FiscalProviderRegistry]
})
export class FiscalRuntimeModule {}
