import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import {
  type CursorPage,
  lowercasedUuidSchema,
  type OrderMessageKindType
} from '@platform/core/domain'
import { ZodValidationPipe } from '@platform/core/http'
import type { Locale } from '@platform/core/i18n'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'

import { OrderMessageHistoryService } from './order-message-history.service'
import { type ListOrderMessagesQuery, listOrderMessagesQuerySchema } from './order-messages.schemas'
import { kindSchema, localeSchema } from './order-templates.schemas'
import { OrderTemplatesService } from './order-templates.service'
import {
  type PluginOrderMessageView,
  type PluginOrderTemplateView,
  pluginHistoryView,
  pluginTemplateView
} from './plugin-order-messages.views'

// What the store said to the customer about an order, and the templates it says it with (Step 5.6 PR E3a): reading only. The history
// needs `orders:read` too (it is about an order a plugin may read), the templates `order-messages:read` alone. Both answer an
// allowlist (`plugin-order-messages.views.ts`). Sending a message, and writing or previewing a template, are PR E3b (they store the
// person who did it).
@Controller()
export class PluginOrderMessagesController {
  constructor(
    private readonly history: OrderMessageHistoryService,
    private readonly templates: OrderTemplatesService
  ) {}

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDER_MESSAGES_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.orders.messages(':id'))
  async list(
    @CurrentStore() store: { id: string },
    @Param('id', new ZodValidationPipe(lowercasedUuidSchema)) orderId: string,
    @Query(new ZodValidationPipe(listOrderMessagesQuerySchema)) query: ListOrderMessagesQuery
  ): Promise<CursorPage<PluginOrderMessageView>> {
    return pluginHistoryView(await this.history.list(store.id, orderId, query))
  }

  @PluginApi(PluginScopes.ORDER_MESSAGES_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.orderTemplates.list)
  async listTemplates(@CurrentStore() store: { id: string }): Promise<PluginOrderTemplateView[]> {
    return (await this.templates.list(store.id)).map(pluginTemplateView)
  }

  @PluginApi(PluginScopes.ORDER_MESSAGES_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.orderTemplates.byKindAndLocale(':kind', ':locale'))
  async getTemplate(
    @CurrentStore() store: { id: string },
    @Param('kind', new ZodValidationPipe(kindSchema)) kind: OrderMessageKindType,
    @Param('locale', new ZodValidationPipe(localeSchema)) locale: Locale
  ): Promise<PluginOrderTemplateView> {
    return pluginTemplateView(await this.templates.get(store.id, kind, locale))
  }
}
