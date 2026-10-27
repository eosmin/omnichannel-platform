import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { uuidSchema } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  type CreateRuleBody,
  createRuleSchema,
  type ReorderBody,
  reorderSchema,
  type UpdateRuleBody,
  updateRuleSchema
} from '@platform/core/messaging'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { type RoutingRuleView, RoutingRulesService } from './routing-rules.service'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(uuidSchema)

// The routing rules of the store in X-Store-Id: who sees them is whoever opens the settings, who
// changes them is whoever manages routing
@Controller()
export class RoutingRulesController {
  constructor(private readonly rules: RoutingRulesService) {}

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.settings.routing)
  list(@CurrentStore() store: Store): Promise<RoutingRuleView[]> {
    return this.rules.list(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_ROUTING)
  @Post(ApiRoutes.settings.routing)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createRuleSchema)) body: CreateRuleBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RoutingRuleView> {
    return this.rules.create(store.id, body, actorOf(user, store, req))
  }

  // Before the routes with an :id, or "order" is read as one
  @RequirePermissions(Permissions.SETTINGS_MANAGE_ROUTING)
  @Patch(ApiRoutes.settings.routingOrder)
  reorder(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(reorderSchema)) body: ReorderBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RoutingRuleView[]> {
    return this.rules.reorder(store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.settings.routingRuleById(':id'))
  get(@CurrentStore() store: Store, @Param('id', id()) ruleId: string): Promise<RoutingRuleView> {
    return this.rules.get(store.id, ruleId)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_ROUTING)
  @Patch(ApiRoutes.settings.routingRuleById(':id'))
  update(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) ruleId: string,
    @Body(new ZodValidationPipe(updateRuleSchema)) body: UpdateRuleBody,
    @Req() req: AuthenticatedRequest
  ): Promise<RoutingRuleView> {
    return this.rules.update(store.id, ruleId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_ROUTING)
  @Delete(ApiRoutes.settings.routingRuleById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) ruleId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.rules.remove(store.id, ruleId, actorOf(user, store, req))
  }
}
