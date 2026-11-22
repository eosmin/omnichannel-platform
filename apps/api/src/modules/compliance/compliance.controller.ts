import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'

import { ApiRoutes } from '@platform/core/api'
import {
  type AuthenticatedUser,
  DsrIntakeThrottle,
  DsrVerifyThrottle,
  Permissions,
  ThrottleProfiles
} from '@platform/core/auth'
import { CurrentUser, OptionalSession, OptionalUser, Public } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, RateLimit, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentStore,
  NoTenantTransaction,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  type CookieConsentBody,
  dsrIntakeBodySchema,
  type DsrIntakeBody,
  dsrVerifyBodySchema,
  type DsrVerifyBody,
  cookieConsentSchema,
  type ListConsentQuery,
  listConsentQuerySchema,
  type RecordConsentBody,
  recordConsentSchema
} from './compliance.schemas'
import { type ConsentList, ConsentService, type RecordedConsent } from './consent.service'
import { type CookieConsentView, CookieConsentService } from './cookie-consent.service'
import { type DsrIntakeAnswer, DsrIntakeService } from './dsr-intake.service'
import { type DsrVerifyAnswer, DsrVerifyService } from './dsr-verify.service'

// The consents of the customers of the store in X-Store-Id. Whoever edits a customer records what the customer said; whoever sees
// customers reads the history.
@Controller()
export class ConsentController {
  constructor(private readonly consents: ConsentService) {}

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @NoStore()
  @Get(ApiRoutes.compliance.consent)
  list(
    @CurrentStore() store: ResolvedTenant['store'],
    @Query(new ZodValidationPipe(listConsentQuerySchema)) query: ListConsentQuery
  ): Promise<ConsentList> {
    return this.consents.list(store.id, query.customerId)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @NoStore()
  @Post(ApiRoutes.compliance.consent)
  @HttpCode(HttpStatusCodes.OK)
  record(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(recordConsentSchema)) body: RecordConsentBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RecordedConsent> {
    return this.consents.record(store.id, body, actorOf(user, store, req))
  }
}

// The answer to the cookie banner: public (a visitor has no account), with a session if the person has one. No store, no
// permission: it is about the person's own browser. The throttle of the public routes bounds what one address can write.
@Controller()
export class CookieConsentController {
  constructor(private readonly cookies: CookieConsentService) {}

  @OptionalSession()
  @RateLimit(ThrottleProfiles.PUBLIC)
  @NoStore()
  @Post(ApiRoutes.compliance.cookieConsent)
  @HttpCode(HttpStatusCodes.OK)
  record(
    @Body(new ZodValidationPipe(cookieConsentSchema)) body: CookieConsentBody,
    @OptionalUser() session: AuthenticatedUser | undefined,
    @Req() req: Request
  ): Promise<CookieConsentView> {
    return this.cookies.record(body, {
      userId: session?.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    })
  }
}

// The public form of data subject requests (TDD_05 §10.2, Step 7.2-H1). PUBLIC on purpose (owner decision on rule 5, written in the plan):
// the person who asks for their data has no account. It takes no store from the headers: the body names the store by the random public
// key the store gave its form, and the worker finds the store from it. Off by default (DSR_PUBLIC_INTAKE_ENABLED); off or on it answers
// the same, so nothing here says whether a customer exists.
@Controller()
export class DsrPublicController {
  constructor(
    private readonly intake: DsrIntakeService,
    private readonly verify: DsrVerifyService
  ) {}

  @Public()
  @NoTenantTransaction(
    'public route: the intake only counts in Redis and queues a sealed job; it opens no tenant context'
  )
  @RateLimit(DsrIntakeThrottle)
  @NoStore()
  @Post(ApiRoutes.compliance.dsr)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  request(
    @Body(new ZodValidationPipe(dsrIntakeBodySchema)) body: DsrIntakeBody
  ): Promise<DsrIntakeAnswer> {
    return this.intake.submit(body)
  }

  @Public()
  @NoTenantTransaction(
    'public route: it finds the request by the hash of the token and opens the context of that request itself'
  )
  @RateLimit(DsrVerifyThrottle)
  @NoStore()
  @Post(ApiRoutes.compliance.dsrVerify)
  @HttpCode(HttpStatusCodes.OK)
  confirm(
    @Body(new ZodValidationPipe(dsrVerifyBodySchema)) body: DsrVerifyBody
  ): Promise<DsrVerifyAnswer> {
    return this.verify.verify(body)
  }
}
