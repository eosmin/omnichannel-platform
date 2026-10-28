import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { PluginInstallationsService, type PluginCatalogEntry } from './plugin-installations.service'
import { type InstallPluginBody, installPluginSchema } from './plugins.schemas'

type Store = ResolvedTenant['store']

// The plugin catalog of the store in X-Store-Id (D19). Seeing it needs SETTINGS_VIEW; installing and
// uninstalling, SETTINGS_MANAGE_PLUGINS.
@Controller()
export class PluginsController {
  constructor(private readonly installations: PluginInstallationsService) {}

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.plugins.available)
  catalog(@CurrentStore() store: Store): Promise<PluginCatalogEntry[]> {
    return this.installations.catalog(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @Post(ApiRoutes.plugins.install)
  @HttpCode(HttpStatusCodes.CREATED)
  install(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(installPluginSchema)) body: InstallPluginBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCatalogEntry> {
    return this.installations.install(store.id, body.pluginId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @Post(ApiRoutes.plugins.revoke(':id'))
  @HttpCode(HttpStatusCodes.OK)
  uninstall(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) installationId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCatalogEntry> {
    return this.installations.uninstall(store.id, installationId, actorOf(user, store, req))
  }
}
