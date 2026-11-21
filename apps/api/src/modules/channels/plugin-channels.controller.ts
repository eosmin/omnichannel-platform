import { Controller, Get, Inject, Param, Query } from '@nestjs/common'
import { z } from 'zod'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { uuidSchema } from '@platform/core/domain'
import { MULTI_FILE_SEND_ENABLED, NoStore, ZodValidationPipe } from '@platform/core/http'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, NoTenantTransaction, RequirePermissions } from '../tenancy'

import {
  ChannelConnectionsService,
  type ChannelDirectoryEntry
} from './channel-connections.service'
import { ChannelTemplatesService, type TemplateView } from './channel-templates.service'

const templatesQuerySchema = z.strictObject({ connectionId: uuidSchema })

// What a plugin may know of the channel accounts of the store (Step 5.6 PR E1, scope `channels:read`): the same directory the
// inbox draws and the templates of one account. The accounts themselves (credentials, tokens, labels, OAuth) stay with the owner.
@Controller()
export class PluginChannelsController {
  constructor(
    private readonly connections: ChannelConnectionsService,
    private readonly templates: ChannelTemplatesService,
    @Inject(MULTI_FILE_SEND_ENABLED) private readonly multiFileEnabled: boolean
  ) {}

  @PluginApi(PluginScopes.CHANNELS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.channels.directory)
  directory(@CurrentStore() store: { id: string }): Promise<ChannelDirectoryEntry[]> {
    return this.connections.directory(store.id, this.multiFileEnabled)
  }

  // As for a person, the templates are for who may send them: `channels:read` stands for MESSAGES_SEND_TEMPLATE (to list them only)
  @PluginApi(PluginScopes.CHANNELS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND_TEMPLATE)
  @NoStore()
  @NoTenantTransaction(
    'lists the templates the provider approved (network): the service reads the connection in one short unit of the store and asks the provider after it with no context open'
  )
  @Get(PluginApiRoutes.channels.templates(':pluginId'))
  list(
    @CurrentStore() store: { id: string },
    @Param('pluginId') pluginId: string,
    @Query(new ZodValidationPipe(templatesQuerySchema)) query: z.output<typeof templatesQuerySchema>
  ): Promise<TemplateView[]> {
    return this.templates.list(store.id, pluginId, query.connectionId)
  }
}
