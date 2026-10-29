import { Body, Controller, Get, HttpCode, Param, Put, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { type WidgetOriginsBody, widgetOriginsSchema } from './widget-settings.schemas'
import { type WidgetEmbedView, WidgetSettings } from './widget-settings.service'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(uuidSchema)

// The widget of a store as its owner manages it (TDD_10 §5.4): the sites that may load it and the
// snippet to paste. Seeing them needs SETTINGS_VIEW and changing the sites SETTINGS_EDIT, as for the
// other channels.
@Controller()
export class WidgetSettingsController {
  constructor(private readonly settings: WidgetSettings) {}

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.channels.widgetEmbed(':id'))
  embed(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<WidgetEmbedView> {
    return this.settings.embed(store.id, connectionId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Put(ApiRoutes.channels.widgetOrigins(':id'))
  @HttpCode(HttpStatusCodes.OK)
  updateOrigins(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) connectionId: string,
    @Body(new ZodValidationPipe(widgetOriginsSchema)) body: WidgetOriginsBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WidgetEmbedView> {
    return this.settings.updateOrigins(
      store.id,
      connectionId,
      body.siteOrigins,
      actorOf(user, store, req)
    )
  }
}
