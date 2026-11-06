import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Redirect,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser, Public } from '@platform/core/auth-module'
import { ChannelOAuthLimits } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, RateLimit, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../../tenancy'
import type { ChannelConnectionView } from '../channel-connections.service'

import {
  type CompleteOAuthBody,
  completeOAuthSchema,
  oauthSessionIdSchema
} from './channel-oauth.schemas'
import { ChannelOAuthService, type OAuthAssetView } from './channel-oauth.service'

type Store = ResolvedTenant['store']

const session = () => new ZodValidationPipe(oauthSessionIdSchema)

// "Connect with Facebook", the part that has a person behind it: the store comes from the guard and never
// from the body, and everything is SETTINGS_EDIT, as connecting a channel is
@Controller()
export class ChannelOAuthController {
  constructor(private readonly oauth: ChannelOAuthService) {}

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @NoStore()
  @Post(ApiRoutes.channels.oauthStart(':pluginId'))
  @HttpCode(HttpStatusCodes.OK)
  start(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('pluginId') pluginId: string
  ): Promise<{ authorizeUrl: string }> {
    return this.oauth.start(store.id, user.id, pluginId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @RateLimit({
    limit: ChannelOAuthLimits.SESSION_LIMIT_PER_MINUTE,
    ttlMs: ChannelOAuthLimits.CALLBACK_WINDOW_MS
  })
  @NoStore()
  @Get(ApiRoutes.channels.oauthAssets(':sessionId'))
  assets(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', session()) sessionId: string
  ): Promise<{ pluginId: string; assets: OAuthAssetView[] }> {
    return this.oauth.assets(store.id, user.id, sessionId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @RateLimit({
    limit: ChannelOAuthLimits.SESSION_LIMIT_PER_MINUTE,
    ttlMs: ChannelOAuthLimits.CALLBACK_WINDOW_MS
  })
  @Post(ApiRoutes.channels.oauthComplete(':sessionId'))
  @HttpCode(HttpStatusCodes.CREATED)
  complete(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', session()) sessionId: string,
    @Body(new ZodValidationPipe(completeOAuthSchema)) body: CompleteOAuthBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ChannelConnectionView> {
    return this.oauth.complete(store.id, actorOf(user, store, req), sessionId, body.assetId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Delete(ApiRoutes.channels.oauthSession(':sessionId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  cancel(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', session()) sessionId: string
  ): Promise<void> {
    return this.oauth.cancel(store.id, user.id, sessionId)
  }
}

// PUBLIC (rule 5 of CLAUDE.md, owner 2026-11-05): the browser comes back from Facebook with none of our
// headers. It does nothing without a `state` of 256 bits that was read once and removed, and it never makes a
// connection: it exchanges the code, keeps a sealed session and sends the browser to the web app with the
// opaque id of that session, or with a reason of the closed list. The answer is a bare redirect that no
// referrer follows and no cache keeps; the address it was called with is never logged (the request log
// redacts `code` and `state`).
@Public()
@RateLimit({
  limit: ChannelOAuthLimits.CALLBACK_LIMIT_PER_MINUTE,
  ttlMs: ChannelOAuthLimits.CALLBACK_WINDOW_MS
})
@Controller()
export class ChannelOAuthCallbackController {
  constructor(private readonly oauth: ChannelOAuthService) {}

  // Answered with a bare redirect: no referrer follows it (the api sends `no-referrer` on everything) and no
  // cache keeps it
  @NoStore()
  @Redirect()
  @Get(ApiRoutes.channels.oauthCallback)
  async callback(
    @Query() query: Record<string, unknown>
  ): Promise<{ url: string; statusCode: number }> {
    return { url: await this.oauth.callback(query), statusCode: HttpStatusCodes.FOUND }
  }
}
