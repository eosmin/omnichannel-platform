import { Module } from '@nestjs/common'

import {
  CryptoPlatformModule,
  FISCAL_SIGNER_URL,
  FiscalSignerPlatformModule,
  QueuesPlatformModule,
  RUNTIME_ENVIRONMENT,
  RuntimeEnvironmentPlatformModule
} from '@platform/core/http'

import { FiscalAnnexService } from './fiscal-annex.service'
import { FiscalContingencyService } from './fiscal-contingency.service'
import { FiscalCustomerDataService } from './fiscal-customer-data.service'
import { FiscalDocumentsService } from './fiscal-documents.service'
import { FiscalEvidenceService } from './fiscal-evidence.service'
import { FiscalIssuerService } from './fiscal-issuer.service'
import { FiscalPartyTaxIdService } from './fiscal-party-tax-id.service'
import { FISCAL_PROVIDERS, FiscalProviderRegistry } from './fiscal-provider.registry'
import { FiscalPurchaseDocumentService } from './fiscal-purchase-document.service'
import { FiscalResealService } from './fiscal-reseal.service'
import { FiscalSweepService } from './fiscal-sweep.service'
import { officialFiscalProviders } from './official-providers'

// The fiscal documents of the organization for the api and for the worker: the providers this deployment has, the issuer and the
// lifecycle of a document. It relies on the global database, audit and event-bus modules of the app.
@Module({
  imports: [
    CryptoPlatformModule,
    FiscalSignerPlatformModule,
    QueuesPlatformModule,
    RuntimeEnvironmentPlatformModule
  ],
  providers: [
    {
      provide: FISCAL_PROVIDERS,
      inject: [RUNTIME_ENVIRONMENT, FISCAL_SIGNER_URL],
      useFactory: (nodeEnv: string, signerUrl: string | null) =>
        officialFiscalProviders(nodeEnv, { signerUrl })
    },
    FiscalProviderRegistry,
    FiscalAnnexService,
    FiscalContingencyService,
    FiscalIssuerService,
    FiscalEvidenceService,
    FiscalDocumentsService,
    FiscalCustomerDataService,
    FiscalPartyTaxIdService,
    FiscalPurchaseDocumentService,
    FiscalResealService,
    FiscalSweepService
  ],
  exports: [
    FiscalAnnexService,
    FiscalContingencyService,
    FiscalDocumentsService,
    FiscalEvidenceService,
    FiscalIssuerService,
    FiscalCustomerDataService,
    FiscalPartyTaxIdService,
    FiscalPurchaseDocumentService,
    FiscalProviderRegistry,
    FiscalResealService,
    FiscalSweepService
  ]
})
export class FiscalRuntimeModule {}
