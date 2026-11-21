import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req
} from '@nestjs/common'
import { z } from 'zod'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import {
  type CursorPage,
  lowercasedUuidSchema,
  type OrderMessageKindType,
  OrderMessageOutcomeStatus,
  OrderMessageTriggers
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { Locale } from '@platform/core/i18n'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { type OrderMessagePreview, pluginDispatchKey } from '@platform/core/shipping'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, NoTenantTransaction, pluginActorOf, RequirePermissions } from '../tenancy'

import { OrderMessageHistoryService } from './order-message-history.service'
import {
  type ListOrderMessagesQuery,
  listOrderMessagesQuerySchema,
  type PluginSendOrderMessageBody,
  pluginSendOrderMessageSchema
} from './order-messages.schemas'
import { type OrderMessageOutcome, OrderMessagesService } from './order-messages.service'
import {
  kindSchema,
  localeSchema,
  type PreviewTemplateBody,
  previewTemplateSchema,
  type PutTemplateBody,
  pluginPutTemplateSchema
} from './order-templates.schemas'
import { OrderTemplatesService } from './order-templates.service'
import {
  type PluginOrderMessageView,
  type PluginOrderTemplateView,
  pluginHistoryView,
  pluginTemplateView
} from './plugin-order-messages.views'

// What a plugin is told of its send: the status, the route and the reason, never the id of the message in the inbox of the store
export type PluginOrderMessageOutcome =
  | Pick<
      Extract<OrderMessageOutcome, { status: typeof OrderMessageOutcomeStatus.SENT }>,
      'status' | 'route'
    >
  | Extract<OrderMessageOutcome, { status: typeof OrderMessageOutcomeStatus.NOT_SENT }>
  | Extract<OrderMessageOutcome, { status: typeof OrderMessageOutcomeStatus.SKIPPED }>
  | Pick<
      Extract<OrderMessageOutcome, { status: typeof OrderMessageOutcomeStatus.DUPLICATE }>,
      'status' | 'route' | 'reason'
    >

function pluginOutcomeView(outcome: OrderMessageOutcome): PluginOrderMessageOutcome {
  switch (outcome.status) {
    case OrderMessageOutcomeStatus.SENT:
      return { status: outcome.status, route: outcome.route }
    case OrderMessageOutcomeStatus.NOT_SENT:
      return { status: outcome.status, reason: outcome.reason }
    case OrderMessageOutcomeStatus.DUPLICATE:
      return { status: outcome.status, route: outcome.route, reason: outcome.reason }
    case OrderMessageOutcomeStatus.SKIPPED:
      return { status: outcome.status }
  }
}

// What the store said to the customer about an order, and the templates it says it with (Step 5.6 PR E3a): reading only. The history
// needs `orders:read` too (it is about an order a plugin may read), the templates `order-messages:read` alone. Both answer an
// allowlist (`plugin-order-messages.views.ts`). Sending a message about an order (`order-messages:write`) and writing, deleting and
// previewing a template (`order-templates:write`) are PR E3b: the plugin is who asked for the message (`requestedByPluginId`, the
// audit as the platform with the plugin in the metadata) and who changed the template (the audit entry). A plugin sends, never
// previews a message about a real order (the rendered text carries the customer's data), and sends it with the key of its call.
@Controller()
export class PluginOrderMessagesController {
  constructor(
    private readonly history: OrderMessageHistoryService,
    private readonly templates: OrderTemplatesService,
    private readonly messages: OrderMessagesService
  ) {}

  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDER_MESSAGES_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @NoStore()
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
  @NoStore()
  @Get(PluginApiRoutes.orderTemplates.list)
  async listTemplates(@CurrentStore() store: { id: string }): Promise<PluginOrderTemplateView[]> {
    return (await this.templates.list(store.id)).map(pluginTemplateView)
  }

  @PluginApi(PluginScopes.ORDER_MESSAGES_READ)
  @RequirePermissions(Permissions.ORDERS_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.orderTemplates.byKindAndLocale(':kind', ':locale'))
  async getTemplate(
    @CurrentStore() store: { id: string },
    @Param('kind', new ZodValidationPipe(kindSchema)) kind: OrderMessageKindType,
    @Param('locale', new ZodValidationPipe(localeSchema)) locale: Locale
  ): Promise<PluginOrderTemplateView> {
    return pluginTemplateView(await this.templates.get(store.id, kind, locale))
  }

  // The outcome says why a message was not sent (the customer was erased, withdrew consent), which is data of the order: the route needs
  // `orders:read` as the history does
  @PluginApi(PluginScopes.ORDERS_READ, PluginScopes.ORDER_MESSAGES_WRITE)
  @RequirePermissions(Permissions.ORDERS_SEND_MESSAGES)
  @NoTenantTransaction(
    'asks the provider to render the approved template (network) and uses the bucket for the summary: the service reads and writes in short units of the store (`inStore`), and the provider and the bucket are called between them with no context open'
  )
  @Post(PluginApiRoutes.orders.messages(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async send(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Param('id', new ZodValidationPipe(lowercasedUuidSchema)) orderId: string,
    // No query: a plugin never previews, and `?preview=true` must not turn into a real send
    @Query(new ZodValidationPipe(z.strictObject({}))) _query: Record<string, never>,
    @Body(new ZodValidationPipe(pluginSendOrderMessageSchema)) body: PluginSendOrderMessageBody
  ): Promise<PluginOrderMessageOutcome> {
    const outcome = await this.messages.send({
      storeId: store.id,
      orderId,
      kind: body.kind,
      trigger: OrderMessageTriggers.MANUAL,
      // The key of the call is the plugin's own: another plugin, or a person's press, with the same text is another request
      idempotencyKey: pluginDispatchKey(orderId, body.kind, installation.id, body.idempotencyKey),
      shipmentId: body.shipmentId,
      requestedBy: null,
      requestedByPluginId: installation.pluginId,
      requestedByInstallationId: installation.id
    })
    return pluginOutcomeView(outcome)
  }

  // The text being edited, rendered with an invented order: nothing is read from the store or written
  @PluginApi(PluginScopes.ORDER_TEMPLATES_WRITE)
  @RequirePermissions(Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES)
  @Post(PluginApiRoutes.orderTemplates.preview)
  @HttpCode(HttpStatusCodes.OK)
  preview(
    @Body(new ZodValidationPipe(previewTemplateSchema)) body: PreviewTemplateBody
  ): OrderMessagePreview {
    return this.templates.preview(body)
  }

  @PluginApi(PluginScopes.ORDER_TEMPLATES_WRITE)
  @RequirePermissions(Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES)
  @NoTenantTransaction(
    'links a template of the channel: the provider is asked whether it exists and is approved (network) between the short units of the store that read the stored link and write the template with its audit entry, with no context open'
  )
  @Put(PluginApiRoutes.orderTemplates.byKindAndLocale(':kind', ':locale'))
  @HttpCode(HttpStatusCodes.OK)
  async putTemplate(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Param('kind', new ZodValidationPipe(kindSchema)) kind: OrderMessageKindType,
    @Param('locale', new ZodValidationPipe(localeSchema)) locale: Locale,
    @Body(new ZodValidationPipe(pluginPutTemplateSchema)) body: PutTemplateBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginOrderTemplateView> {
    return pluginTemplateView(
      await this.templates.put(
        store.id,
        kind,
        locale,
        body,
        pluginActorOf(installation, store, req),
        { keepSettings: true }
      )
    )
  }

  @PluginApi(PluginScopes.ORDER_TEMPLATES_WRITE)
  @RequirePermissions(Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES)
  @Delete(PluginApiRoutes.orderTemplates.byKindAndLocale(':kind', ':locale'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  removeTemplate(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Param('kind', new ZodValidationPipe(kindSchema)) kind: OrderMessageKindType,
    @Param('locale', new ZodValidationPipe(localeSchema)) locale: Locale,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    return this.templates.remove(store.id, kind, locale, pluginActorOf(installation, store, req))
  }
}
