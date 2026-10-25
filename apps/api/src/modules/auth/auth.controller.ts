import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common'
import type { Request } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, MagicLinkThrottle, ThrottleProfiles } from '@platform/core/auth'
import { CurrentUser, Public } from '@platform/core/auth-module'
import { NoStore, RateLimit, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { SkipTenant } from '../tenancy'

import { type AccountProfile, AccountService } from './account.service'
import {
  type MagicLinkConsumeBody,
  magicLinkConsumeSchema,
  type MagicLinkRequestBody,
  magicLinkRequestSchema,
  type RefreshBody,
  refreshSchema,
  sessionIdSchema
} from './auth.schemas'
import { type ConsumedMagicLink, MagicLinkService } from './magic-link.service'
import {
  type ActiveSession,
  type IssuedSession,
  type SessionContext,
  SessionService
} from './session.service'

const HTTP_OK = 200
const HTTP_ACCEPTED = 202
const HTTP_NO_CONTENT = 204

function contextOf(req: Request): SessionContext {
  return { userAgent: req.get('user-agent'), ipAddress: req.ip }
}

// Every route here belongs to a person (log in, refresh, the session, the account), none to a store
@SkipTenant()
@Controller()
export class AuthController {
  constructor(
    private readonly magicLinks: MagicLinkService,
    private readonly sessions: SessionService,
    private readonly account: AccountService
  ) {}

  // Same answer for any address, known or not
  @Public()
  @RateLimit(MagicLinkThrottle)
  @Post(ApiRoutes.auth.magicLinkRequest)
  @HttpCode(HTTP_ACCEPTED)
  async requestMagicLink(
    @Body(new ZodValidationPipe(magicLinkRequestSchema)) body: MagicLinkRequestBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ accepted: true }> {
    await this.magicLinks.request(body.email, req.correlationId)
    return { accepted: true }
  }

  @Public()
  @RateLimit(MagicLinkThrottle)
  @NoStore()
  @Post(ApiRoutes.auth.magicLinkConsume)
  @HttpCode(HTTP_OK)
  consumeMagicLink(
    @Body(new ZodValidationPipe(magicLinkConsumeSchema)) body: MagicLinkConsumeBody,
    @Req() req: Request
  ): Promise<ConsumedMagicLink> {
    return this.magicLinks.consume(body.token, contextOf(req))
  }

  // Public: the refresh token is the credential, the access token has already expired by then
  @Public()
  @RateLimit(ThrottleProfiles.PUBLIC)
  @NoStore()
  @Post(ApiRoutes.auth.refresh)
  @HttpCode(HTTP_OK)
  refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshBody,
    @Req() req: Request
  ): Promise<IssuedSession> {
    return this.sessions.refresh(body.refreshToken, contextOf(req))
  }

  @Post(ApiRoutes.auth.logout)
  @HttpCode(HTTP_NO_CONTENT)
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.sessions.logout(user.id, user.sessionFamilyId)
  }

  @NoStore()
  @Get(ApiRoutes.auth.me)
  me(@CurrentUser() user: AuthenticatedUser): Promise<AccountProfile> {
    return this.account.profile(user.id)
  }

  @NoStore()
  @Get(ApiRoutes.auth.sessions)
  listSessions(@CurrentUser() user: AuthenticatedUser): Promise<ActiveSession[]> {
    return this.sessions.listActive(user.id, user.sessionFamilyId)
  }

  @Delete(ApiRoutes.auth.sessionById(':id'))
  @HttpCode(HTTP_NO_CONTENT)
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(sessionIdSchema)) id: string
  ): Promise<void> {
    await this.sessions.revokeOwn(user.id, id)
  }
}
