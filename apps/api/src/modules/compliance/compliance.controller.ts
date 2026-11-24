import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'
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
import { lowercasedUuidSchema } from '@platform/core/domain'
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
  type DsrApproveBody,
  dsrApproveBodySchema,
  type DsrDecisionBody,
  type DsrFormKeyBody,
  dsrFormKeyBodySchema,
  dsrDecisionBodySchema,
  dsrIntakeBodySchema,
  type DsrIntakeBody,
  dsrVerifyBodySchema,
  type DsrVerifyBody,
  cookieConsentSchema,
  type ListConsentQuery,
  type ListDsrQuery,
  listConsentQuerySchema,
  listDsrQuerySchema,
  type RecordConsentBody,
  recordConsentSchema
} from './compliance.schemas'
import { type ConsentList, ConsentService, type RecordedConsent } from './consent.service'
import { type CookieConsentView, CookieConsentService } from './cookie-consent.service'
import { type DsrFormView, DsrFormService } from './dsr-form.service'
import { type DsrIntakeAnswer, DsrIntakeService } from './dsr-intake.service'
import {
  type DsrRequestDetail,
  type DsrRequestPage,
  type DsrRequestView,
  DsrReviewService
} from './dsr-review.service'
import { type DsrVerifyAnswer, DsrVerifyService } from './dsr-verify.service'

const id = () => new ZodValidationPipe(lowercasedUuidSchema)

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

// The review queue of the data requests of the store in X-Store-Id (Step 7.2-H1b). Whoever holds `customers:dsr_review` reads the queue and
// decides; the store is the one of the `TenantGuard`, so the id of a request of another store is a 404 on every route.
@Controller()
export class DsrReviewController {
  constructor(private readonly review: DsrReviewService) {}

  @RequirePermissions(Permissions.CUSTOMERS_DSR_REVIEW)
  @NoStore()
  @Get(ApiRoutes.compliance.dsr)
  list(
    @CurrentStore() store: ResolvedTenant['store'],
    @Query(new ZodValidationPipe(listDsrQuerySchema)) query: ListDsrQuery
  ): Promise<DsrRequestPage> {
    return this.review.list(store.id, query)
  }

  @RequirePermissions(Permissions.CUSTOMERS_DSR_REVIEW)
  @NoStore()
  @Get(ApiRoutes.compliance.dsrById(':id'))
  get(
    @CurrentStore() store: ResolvedTenant['store'],
    @Param('id', id()) requestId: string
  ): Promise<DsrRequestDetail> {
    return this.review.get(store.id, requestId)
  }

  // The signed link to the file of a finished access or portability request: short-lived, audited with who asked for it
  @RequirePermissions(Permissions.CUSTOMERS_DSR_REVIEW)
  @NoStore()
  @Get(ApiRoutes.compliance.dsrExport(':id'))
  exportLink(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) requestId: string,
    @Req() req: AuthenticatedRequest
  ): ReturnType<DsrReviewService['exportLink']> {
    return this.review.exportLink(store.id, requestId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CUSTOMERS_DSR_REVIEW)
  @NoStore()
  @Post(ApiRoutes.compliance.dsrApprove(':id'))
  @HttpCode(HttpStatusCodes.OK)
  approve(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) requestId: string,
    @Body(new ZodValidationPipe(dsrApproveBodySchema)) body: DsrApproveBody,
    @Req() req: AuthenticatedRequest
  ): Promise<DsrRequestView> {
    return this.review.approve(store.id, requestId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CUSTOMERS_DSR_REVIEW)
  @NoStore()
  @Post(ApiRoutes.compliance.dsrReject(':id'))
  @HttpCode(HttpStatusCodes.OK)
  reject(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) requestId: string,
    @Body(new ZodValidationPipe(dsrDecisionBodySchema)) body: DsrDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<DsrRequestView> {
    return this.review.reject(store.id, requestId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CUSTOMERS_DSR_REVIEW)
  @NoStore()
  @Post(ApiRoutes.compliance.dsrCancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  cancel(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) requestId: string,
    @Body(new ZodValidationPipe(dsrDecisionBodySchema)) body: DsrDecisionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<DsrRequestView> {
    return this.review.cancel(store.id, requestId, body, actorOf(user, store, req))
  }
}

// The key of the public form of the store in X-Store-Id (Step 7.2-H2b, C1a). Its own permission: replacing it breaks every link of the form
// already published. The store is the one of the `TenantGuard`; a key of another store is never read or written.
@Controller()
export class DsrFormController {
  constructor(private readonly form: DsrFormService) {}

  @RequirePermissions(Permissions.CUSTOMERS_DSR_MANAGE_FORM)
  @NoStore()
  @Get(ApiRoutes.compliance.dsrForm)
  get(@CurrentStore() store: ResolvedTenant['store']): Promise<DsrFormView> {
    return this.form.get(store.id)
  }

  @RequirePermissions(Permissions.CUSTOMERS_DSR_MANAGE_FORM)
  @NoStore()
  @Post(ApiRoutes.compliance.dsrFormKey)
  @HttpCode(HttpStatusCodes.OK)
  makeKey(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(dsrFormKeyBodySchema)) body: DsrFormKeyBody,
    @Req() req: AuthenticatedRequest
  ): Promise<DsrFormView> {
    return this.form.makeKey(store.id, body, actorOf(user, store, req))
  }

  // A POST and not a DELETE: the key to switch off travels in the body (the same compare and swap), and a body on a DELETE is dropped by
  // some proxies
  @RequirePermissions(Permissions.CUSTOMERS_DSR_MANAGE_FORM)
  @NoStore()
  @Post(ApiRoutes.compliance.dsrFormKeyRevoke)
  @HttpCode(HttpStatusCodes.OK)
  revoke(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(dsrFormKeyBodySchema)) body: DsrFormKeyBody,
    @Req() req: AuthenticatedRequest
  ): Promise<DsrFormView> {
    return this.form.revoke(store.id, body, actorOf(user, store, req))
  }
}
