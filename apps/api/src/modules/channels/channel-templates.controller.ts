import { Controller, Get, Param, Query } from '@nestjs/common'
import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { uuidSchema } from '@platform/core/domain'
import { ZodValidationPipe } from '@platform/core/http'

import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { ChannelTemplatesService, type TemplateView } from './channel-templates.service'

// The connection is named because a store may hold more than one account of a plugin, and the
// templates belong to the account
const templatesQuerySchema = z.strictObject({ connectionId: uuidSchema })

// For the composer of an agent whose messaging window is closed: it needs to see conversations and
// to send templates, not to manage the channel
@Controller()
export class ChannelTemplatesController {
  constructor(private readonly templates: ChannelTemplatesService) {}

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND_TEMPLATE)
  @Get(ApiRoutes.channels.templates(':pluginId'))
  list(
    @CurrentStore() store: ResolvedTenant['store'],
    @Param('pluginId') pluginId: string,
    @Query(new ZodValidationPipe(templatesQuerySchema)) query: z.output<typeof templatesQuerySchema>
  ): Promise<TemplateView[]> {
    return this.templates.list(store.id, pluginId, query.connectionId)
  }
}
