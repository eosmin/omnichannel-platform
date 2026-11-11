import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import type { OrderMessageKindType } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { Locale } from '@platform/core/i18n'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { OrderMessagePreview } from '@platform/core/shipping'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  kindSchema,
  localeSchema,
  type PreviewTemplateBody,
  previewTemplateSchema,
  type PutTemplateBody,
  putTemplateSchema
} from './order-templates.schemas'
import { OrderTemplatesService } from './order-templates.service'
import type { OrderTemplateView } from './order-templates.support'

type Store = ResolvedTenant['store']

const kind = () => new ZodValidationPipe(kindSchema)
const locale = () => new ZodValidationPipe(localeSchema)

// Settings → Order messages (TDD_17 §4.7, §6). Reading the templates is for whoever sees orders; writing, deleting and
// previewing one is SETTINGS_MANAGE_ORDER_TEMPLATES. The store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class OrderTemplatesController {
  constructor(private readonly templates: OrderTemplatesService) {}

  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(ApiRoutes.orderTemplates.list)
  list(@CurrentStore() store: Store): Promise<OrderTemplateView[]> {
    return this.templates.list(store.id)
  }

  // The text being edited, rendered with a sample order: nothing is read or written
  @RequirePermissions(Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES)
  @Post(ApiRoutes.orderTemplates.preview)
  @HttpCode(HttpStatusCodes.OK)
  preview(
    @Body(new ZodValidationPipe(previewTemplateSchema)) body: PreviewTemplateBody
  ): OrderMessagePreview {
    return this.templates.preview(body)
  }

  @RequirePermissions(Permissions.ORDERS_VIEW)
  @Get(ApiRoutes.orderTemplates.byKindAndLocale(':kind', ':locale'))
  get(
    @CurrentStore() store: Store,
    @Param('kind', kind()) templateKind: OrderMessageKindType,
    @Param('locale', locale()) templateLocale: Locale
  ): Promise<OrderTemplateView> {
    return this.templates.get(store.id, templateKind, templateLocale)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES)
  @Put(ApiRoutes.orderTemplates.byKindAndLocale(':kind', ':locale'))
  @HttpCode(HttpStatusCodes.OK)
  put(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind', kind()) templateKind: OrderMessageKindType,
    @Param('locale', locale()) templateLocale: Locale,
    @Body(new ZodValidationPipe(putTemplateSchema)) body: PutTemplateBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrderTemplateView> {
    return this.templates.put(
      store.id,
      templateKind,
      templateLocale,
      body,
      actorOf(user, store, req)
    )
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES)
  @Delete(ApiRoutes.orderTemplates.byKindAndLocale(':kind', ':locale'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  remove(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind', kind()) templateKind: OrderMessageKindType,
    @Param('locale', locale()) templateLocale: Locale,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    return this.templates.remove(store.id, templateKind, templateLocale, actorOf(user, store, req))
  }
}
