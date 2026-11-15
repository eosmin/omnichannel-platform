import { Body, Controller, Delete, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { PluginApiRoutes } from '@platform/core/api'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  remoteChannelEventsBodySchema,
  type RemoteChannelEventsBody
} from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, pluginActorOf } from '../tenancy'

import { PluginChannelConnectionsService } from './plugin-channel-connections.service'
import { PluginChannelEventsService } from './plugin-channel-events.service'
import {
  connectionIdParamSchema,
  type PutConnectionBody,
  putConnectionSchema
} from './plugin-channel.schemas'

type Installation = { id: string; pluginId: string }
type Store = { id: string }

// What a remote CHANNEL plugin says to the platform (TDD_10 §6.7.5): its accounts, and what its customers write. The store, the
// plugin and the installation are those of the key and nothing else: no route reads them from the body, the query or a header. The
// scopes grant no human permission (a person links an account in the plugin's settings page), so the routes name none.
@Controller()
export class PluginChannelController {
  constructor(
    private readonly connections: PluginChannelConnectionsService,
    private readonly events: PluginChannelEventsService
  ) {}

  // 201 when the account is new, 200 when it existed (or was reactivated)
  @PluginApi(PluginScopes.CHANNEL_CONNECTIONS)
  @Put(PluginApiRoutes.channel.connection(':connectionId'))
  async put(
    @Param('connectionId', new ZodValidationPipe(connectionIdParamSchema)) connectionId: string,
    @Body(new ZodValidationPipe(putConnectionSchema)) body: PutConnectionBody,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentStore() store: Store,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response
  ): Promise<void> {
    const created = await this.connections.put(
      { installationId: installation.id, pluginId: installation.pluginId, storeId: store.id },
      connectionId,
      body,
      pluginActorOf(installation, store, request)
    )
    response.status(created ? HttpStatusCodes.CREATED : HttpStatusCodes.OK)
  }

  @PluginApi(PluginScopes.CHANNEL_CONNECTIONS)
  @Delete(PluginApiRoutes.channel.connection(':connectionId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async disconnect(
    @Param('connectionId', new ZodValidationPipe(connectionIdParamSchema)) connectionId: string,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentStore() store: Store,
    @Req() request: AuthenticatedRequest
  ): Promise<void> {
    await this.connections.disconnect(
      { installationId: installation.id, pluginId: installation.pluginId, storeId: store.id },
      connectionId,
      pluginActorOf(installation, store, request)
    )
  }

  @PluginApi(PluginScopes.CHANNEL_EVENTS)
  @Post(PluginApiRoutes.channel.events)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  async report(
    @Body(new ZodValidationPipe(remoteChannelEventsBodySchema)) body: RemoteChannelEventsBody,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentStore() store: Store
  ): Promise<{ accepted: number }> {
    const accepted = await this.events.ingest(
      { installationId: installation.id, pluginId: installation.pluginId, storeId: store.id },
      body.events
    )
    return { accepted }
  }
}
