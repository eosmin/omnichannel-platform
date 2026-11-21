import { Module } from '@nestjs/common'

import { CompliancePlatformModule } from '@platform/core/http'

import { TenancyModule } from '../tenancy'

import { ConsentController, CookieConsentController } from './compliance.controller'
import { ConsentService } from './consent.service'
import { CookieConsentService } from './cookie-consent.service'

// The consents of customers and the answers to the cookie banner (TDD_05 §10, Step 7.2). The erasure and the requests of the
// people it is about (DSR) are in the modules of customers and, later, of the requests.
@Module({
  imports: [TenancyModule, CompliancePlatformModule],
  controllers: [ConsentController, CookieConsentController],
  providers: [ConsentService, CookieConsentService]
})
export class ComplianceModule {}
