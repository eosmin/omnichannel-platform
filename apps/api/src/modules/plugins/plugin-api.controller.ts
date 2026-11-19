import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { ThrottleProfiles } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, RateLimit, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { CurrentStore, NoTenantTransaction } from '../tenancy'

import { CurrentPluginInstallation, PluginApi } from './plugin-api.decorators'
import { PluginSetupExchangeService, type PluginSetupResult } from './plugin-setup-exchange.service'
import { type ExchangeSetupBody, exchangeSetupSchema } from './plugins.schemas'

// What a key says about itself: its installation, its plugin, its store and what it was granted
export interface PluginInstallationView {
  installationId: string
  pluginId: string
  storeId: string
  scopes: string[]
}

// The routes of the plugin API that no other step owns: how a plugin gets its key and how it asks who it is. The routes that
// reach what the store holds belong to the PRs of Step 5.6 that expose them, each with `@PluginApi(scopes)`.
@Controller()
export class PluginApiController {
  constructor(private readonly setup: PluginSetupExchangeService) {}

  // The one route of the plugin API without a key: the plugin has none yet, and the one-time code is the credential. Public, and
  // limited per address like the other routes whose credential is a secret in the body. The answer carries the key and must not be
  // stored by anything between the plugin and the platform.
  @Public()
  @NoTenantTransaction(
    'public: the exchange opens the context of the store of the code (JobContext.forStore)'
  )
  @RateLimit(ThrottleProfiles.PUBLIC)
  @NoStore()
  @Post(PluginApiRoutes.setupExchange)
  @HttpCode(HttpStatusCodes.OK)
  exchange(
    @Body(new ZodValidationPipe(exchangeSetupSchema)) body: ExchangeSetupBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginSetupResult> {
    return this.setup.exchange(body.code, { ipAddress: req.ip, userAgent: req.get('user-agent') })
  }

  // Any active key: no scope is needed to learn what the key itself is
  @PluginApi()
  @NoStore()
  @Get(PluginApiRoutes.installation)
  installation(
    @CurrentPluginInstallation()
    installation: { id: string; pluginId: string; scopes: readonly string[] },
    @CurrentStore() store: { id: string }
  ): PluginInstallationView {
    return {
      installationId: installation.id,
      pluginId: installation.pluginId,
      storeId: store.id,
      scopes: [...installation.scopes]
    }
  }
}
