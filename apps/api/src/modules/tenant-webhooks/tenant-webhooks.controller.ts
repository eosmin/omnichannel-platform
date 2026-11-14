import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  type CreateWebhookBody,
  createWebhookSchema,
  idSchema,
  type ListDeliveriesQuery,
  listDeliveriesQuerySchema,
  type UpdateWebhookBody,
  updateWebhookSchema
} from './tenant-webhooks.schemas'
import { TenantWebhooksService } from './tenant-webhooks.service'
import type {
  WebhookDeliveryPage,
  WebhookView,
  WebhookWithSecretView
} from './tenant-webhooks.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(idSchema)

// Settings → Webhooks of the store in X-Store-Id. One permission for all of it: a webhook sends the events of the
// store to an address of the owner's choosing, so even reading the list is for whoever manages them.
@Controller()
export class TenantWebhooksController {
  constructor(private readonly webhooks: TenantWebhooksService) {}

  @RequirePermissions(Permissions.SETTINGS_MANAGE_WEBHOOKS)
  @Get(ApiRoutes.settings.webhooks)
  list(@CurrentStore() store: Store): Promise<WebhookView[]> {
    return this.webhooks.list(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_WEBHOOKS)
  @Post(ApiRoutes.settings.webhooks)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createWebhookSchema)) body: CreateWebhookBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WebhookWithSecretView> {
    return this.webhooks.create(store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_WEBHOOKS)
  @Get(ApiRoutes.settings.webhookById(':id'))
  get(@CurrentStore() store: Store, @Param('id', id()) webhookId: string): Promise<WebhookView> {
    return this.webhooks.get(store.id, webhookId)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_WEBHOOKS)
  @Patch(ApiRoutes.settings.webhookById(':id'))
  update(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) webhookId: string,
    @Body(new ZodValidationPipe(updateWebhookSchema)) body: UpdateWebhookBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WebhookView> {
    return this.webhooks.update(store.id, webhookId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_WEBHOOKS)
  @Delete(ApiRoutes.settings.webhookById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  remove(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) webhookId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    return this.webhooks.remove(store.id, webhookId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_WEBHOOKS)
  @Post(ApiRoutes.settings.webhookSecret(':id'))
  @HttpCode(HttpStatusCodes.OK)
  rotateSecret(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) webhookId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<WebhookWithSecretView> {
    return this.webhooks.rotateSecret(store.id, webhookId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_WEBHOOKS)
  @Get(ApiRoutes.settings.webhookDeliveries(':id'))
  deliveries(
    @CurrentStore() store: Store,
    @Param('id', id()) webhookId: string,
    @Query(new ZodValidationPipe(listDeliveriesQuerySchema)) query: ListDeliveriesQuery
  ): Promise<WebhookDeliveryPage> {
    return this.webhooks.deliveries(store.id, webhookId, query)
  }
}
