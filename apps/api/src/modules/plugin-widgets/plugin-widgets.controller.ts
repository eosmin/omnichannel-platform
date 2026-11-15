import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { PluginBridgeMessages, type PluginBridgeResponse } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import { viewerOf } from '@platform/core/messaging'

import {
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  type OpenWidgetSessionBody,
  openWidgetSessionSchema,
  type WidgetBridgeBody,
  widgetBridgeSchema
} from './plugin-widgets.schemas'
import {
  type PluginWidgetSession,
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
  @Get(ApiRoutes.pluginWidgets.list)
  list(@CurrentStore() store: Store): Promise<PluginWidgetView[]> {
    return this.widgets.list(store.id)
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
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
      body.conversationId
    )
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
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
