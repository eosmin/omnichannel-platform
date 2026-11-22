import { Module } from '@nestjs/common'

import { CompliancePlatformModule, QueuesPlatformModule } from '@platform/core/http'

import { TenancyModule } from '../tenancy'

import {
  ConsentController,
  CookieConsentController,
  DsrPublicController
} from './compliance.controller'
import { ConsentService } from './consent.service'
import { CookieConsentService } from './cookie-consent.service'
import { DsrIntakeService } from './dsr-intake.service'
import { DsrVerifyService } from './dsr-verify.service'

// The consents of customers and the answers to the cookie banner (TDD_05 §10, Step 7.2). The erasure and the requests of the
// people it is about (DSR) are in the modules of customers and, later, of the requests.
@Module({
  imports: [TenancyModule, CompliancePlatformModule, QueuesPlatformModule],
  controllers: [ConsentController, CookieConsentController, DsrPublicController],
  providers: [ConsentService, CookieConsentService, DsrIntakeService, DsrVerifyService]
})
export class ComplianceModule {}
