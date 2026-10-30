import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { type ConnectChannelBody, connectChannelSchema } from './channel-connections.schemas'
import {
  type ChannelConnectionView,
  ChannelConnectionsService,
  type ChannelDirectoryEntry,
  type ChannelTestResult
} from './channel-connections.service'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(uuidSchema)

// The channels of the store in X-Store-Id (TDD_10 §10). Managing them needs SETTINGS_VIEW and
// SETTINGS_EDIT: there is no permission of their own, and the plan gating of the TDD is omitted in the
// v1.2 MVP. The one exception is `directory`, which any role that sees conversations may read.
@Controller()
export class ChannelConnectionsController {
  constructor(private readonly connections: ChannelConnectionsService) {}

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.channels.connections)
  list(@CurrentStore() store: Store): Promise<ChannelConnectionView[]> {
    return this.connections.list(store.id)
  }

  // For every agent, unlike the list above, which needs SETTINGS_VIEW: it answers only what the
  // inbox needs to name and draw a channel
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.channels.directory)
  directory(@CurrentStore() store: Store): Promise<ChannelDirectoryEntry[]> {
    return this.connections.directory(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.channels.connectionById(':id'))
  get(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<ChannelConnectionView> {
    return this.connections.get(store.id, connectionId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Post(ApiRoutes.channels.connect(':pluginId'))
  @HttpCode(HttpStatusCodes.CREATED)
  connect(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('pluginId') pluginId: string,
    @Body(new ZodValidationPipe(connectChannelSchema)) body: ConnectChannelBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ChannelConnectionView> {
    return this.connections.connect(store.id, pluginId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Post(ApiRoutes.channels.test(':id'))
  @HttpCode(HttpStatusCodes.OK)
  test(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<ChannelTestResult> {
    return this.connections.test(store.id, connectionId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Post(ApiRoutes.channels.disconnect(':id'))
  @HttpCode(HttpStatusCodes.OK)
  disconnect(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) connectionId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<ChannelConnectionView> {
    return this.connections.disconnect(store.id, connectionId, actorOf(user, store, req))
  }
}
