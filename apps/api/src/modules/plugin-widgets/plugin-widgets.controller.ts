import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { PluginBridgeMessages, type PluginBridgeResponse, uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { viewerOf } from '@platform/core/messaging'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  type OpenWidgetSessionBody,
  openWidgetSessionSchema,
  type WidgetBridgeBody,
  widgetBridgeSchema,
  widgetIdSchema,
  type WidgetVisibilityBody,
  widgetVisibilitySchema
} from './plugin-widgets.schemas'
import {
  type PluginWidgetSession,
  type PluginWidgetSettingsView,
  type PluginWidgetView,
  PluginWidgetsService
} from './plugin-widgets.service'

type Store = ResolvedTenant['store']

// The widgets of the plugins in the agent sidebar (TDD_10 §7). Everything here is the signed-in agent's own
// call, through AuthGuard and TenantGuard: the frame of a plugin never reaches these routes, the page does, on
// the agent's session, and what the page forwards is checked again.
@Controller()
export class PluginWidgetsController {
  constructor(private readonly widgets: PluginWidgetsService) {}

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
  @Get(ApiRoutes.pluginWidgets.list)
  list(@CurrentStore() store: Store): Promise<PluginWidgetView[]> {
    return this.widgets.list(store.id)
  }

  // Settings → Plugins: all of them, the hidden ones with `visible: false`
  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @NoStore()
  @Get(ApiRoutes.pluginWidgets.settings)
  settings(@CurrentStore() store: Store): Promise<PluginWidgetSettingsView[]> {
    return this.widgets.settings(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
  @Put(ApiRoutes.pluginWidgets.visibility(':installationId', ':widgetId'))
  setVisible(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('installationId', new ZodValidationPipe(uuidSchema)) installationId: string,
    @Param('widgetId', new ZodValidationPipe(widgetIdSchema)) widgetId: string,
    @Body(new ZodValidationPipe(widgetVisibilitySchema)) body: WidgetVisibilityBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginWidgetSettingsView> {
    return this.widgets.setVisible(
      store.id,
      installationId,
      widgetId,
      body.visible,
      actorOf(user, store, req)
    )
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
  @Post(ApiRoutes.pluginWidgets.sessions)
  @HttpCode(HttpStatusCodes.CREATED)
  openSession(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(openWidgetSessionSchema)) body: OpenWidgetSessionBody
  ): Promise<PluginWidgetSession> {
    return this.widgets.openSession(
      store.id,
      viewerOf(user.id, held),
      body.installationId,
      body.conversationId,
      body.widgetId
    )
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
  @Post(ApiRoutes.pluginWidgets.bridge)
  @HttpCode(HttpStatusCodes.OK)
  async bridge(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(widgetBridgeSchema)) body: WidgetBridgeBody
  ): Promise<PluginBridgeResponse> {
    const data = await this.widgets.call(
      store.id,
      viewerOf(user.id, held),
      body.token,
      body.request
    )
    return { type: PluginBridgeMessages.RESPONSE, id: body.request.id, ok: true, data }
  }
}
