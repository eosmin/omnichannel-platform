import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentStore,
  NoTenantTransaction,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  PluginCommandSecretService,
  type RotatedCommandSecret
} from './plugin-command-secret.service'
import { PluginDeletionService } from './plugin-deletion.service'
import {
  type PluginCatalogEntry,
  type PluginDetail,
  PluginInstallationsService,
  type PluginInstallResult
} from './plugin-installations.service'
import type { PluginConsent, PluginSetupOffer } from './plugin-integration-install.service'
import {
  PluginRegistrationService,
  RegistrationOutcomes,
  type RegisteredPlugin
} from './plugin-registration.service'
import {
  type DeletePluginBody,
  deletePluginSchema,
  type InstallPluginBody,
  installPluginSchema,
  pluginIdSchema,
  pluginLookupSchema,
  type RegisterPluginBody,
  registerPluginSchema,
  type RevokePluginBody,
  revokePluginSchema
} from './plugins.schemas'

type Store = ResolvedTenant['store']

// The plugin catalog of the store in X-Store-Id (D19). Seeing it needs SETTINGS_VIEW; installing and
// uninstalling, SETTINGS_MANAGE_PLUGINS.
@Controller()
export class PluginsController {
  constructor(
    private readonly installations: PluginInstallationsService,
    private readonly registration: PluginRegistrationService,
    private readonly commandSecrets: PluginCommandSecretService,
    private readonly deletion: PluginDeletionService
  ) {}

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @NoStore()
  @Get(ApiRoutes.plugins.available)
  catalog(@CurrentStore() store: Store): Promise<PluginCatalogEntry[]> {
    return this.installations.catalog(store)
  }

  // One plugin and what this store holds of it (the id is the plugin's). It names the scopes granted, the prefix of the key and the
  // address of the webhook, so it is for who manages plugins, not for who only sees the catalog.
  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @NoStore()
  @Get(ApiRoutes.plugins.byId(':id'))
  byId(
    @CurrentStore() store: Store,
    @Param('id', new ZodValidationPipe(pluginLookupSchema)) pluginId: string
  ): Promise<PluginDetail> {
    return this.installations.detail(store, pluginId)
  }

  // Removes a plugin the organization registered, with the name typed (the id is the plugin's): only one with no live installation
  // anywhere in the organization; 409 `PLUGIN_IN_USE` otherwise
  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @Delete(ApiRoutes.plugins.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(pluginLookupSchema)) pluginId: string,
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(deletePluginSchema)) body?: DeletePluginBody
  ): Promise<void> {
    await this.deletion.delete(store, pluginId, body?.confirmation, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  // The answer of an integration plugin carries the one-time setup code: not stored by anything between the owner and the platform
  @NoStore()
  @NoTenantTransaction(
    'the challenge of an integration plugin is an HTTPS call to its address (pinnedHttpsExchange): short contexts of its own, F6-3f'
  )
  @Post(ApiRoutes.plugins.install)
  @HttpCode(HttpStatusCodes.CREATED)
  install(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(installPluginSchema)) body: InstallPluginBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginInstallResult> {
    return this.installations.install(store, body.pluginId, body.scopes, actorOf(user, store, req))
  }

  // What installing an integration plugin would grant: the consent screen reads it (the id is the plugin's)
  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @NoStore()
  @Get(ApiRoutes.plugins.consent(':id'))
  consent(
    @CurrentStore() store: Store,
    @Param('id', new ZodValidationPipe(pluginIdSchema)) pluginId: string
  ): Promise<PluginConsent> {
    return this.installations.consent(store, pluginId)
  }

  // A new one-time code for an installation that is waiting for its plugin (the id is the installation's); shown once, and the
  // earlier code stops working. The answer carries a secret and is not stored.
  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @NoStore()
  @Post(ApiRoutes.plugins.setupCode(':id'))
  @HttpCode(HttpStatusCodes.OK)
  setupCode(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) installationId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginSetupOffer> {
    return this.installations.reissueSetupCode(store, installationId, actorOf(user, store, req))
  }

  // A new secret for the commands to a remote channel (the id is the installation's): shown once, and the previous one still signs for
  // ten minutes. The answer carries a secret and is not stored.
  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @NoStore()
  @Post(ApiRoutes.plugins.commandSecret(':id'))
  @HttpCode(HttpStatusCodes.OK)
  rotateCommandSecret(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) installationId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<RotatedCommandSecret> {
    return this.commandSecrets.rotate(store, installationId, actorOf(user, store, req))
  }

  // The owner pastes the manifest of an integration plugin (D10): 201 when the id is new, 200 when a newer version of one of
  // the organization's own plugins replaced the older one, or the same manifest was sent again
  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @Post(ApiRoutes.plugins.register)
  async register(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(registerPluginSchema)) body: RegisterPluginBody,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<RegisteredPlugin> {
    const registered = await this.registration.register(store, body, actorOf(user, store, req))
    res.status(
      registered.outcome === RegistrationOutcomes.CREATED
        ? HttpStatusCodes.CREATED
        : HttpStatusCodes.OK
    )
    return registered
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @Post(ApiRoutes.plugins.revoke(':id'))
  @HttpCode(HttpStatusCodes.OK)
  uninstall(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) installationId: string,
    @Req() req: AuthenticatedRequest,
    // The word the owner typed: an integration plugin is revoked only with it (TDD_10 §6.6); a channel plugin takes no body
    @Body(new ZodValidationPipe(revokePluginSchema)) body?: RevokePluginBody
  ): Promise<PluginCatalogEntry> {
    return this.installations.uninstall(
      store,
      installationId,
      actorOf(user, store, req),
      body?.confirmation
    )
  }
}
