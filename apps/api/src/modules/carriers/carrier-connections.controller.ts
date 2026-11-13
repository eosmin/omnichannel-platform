import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type ConnectCarrierBody,
  connectCarrierSchema,
  type CursorPage,
  type UpdateCarrierBody,
  updateCarrierSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  connectionIdSchema,
  type ListCarriersQuery,
  listCarriersQuerySchema,
  type ListLocationsQuery,
  listLocationsQuerySchema
} from './carrier-connections.schemas'
import { CarrierConnectionsService } from './carrier-connections.service'
import type {
  CarrierConnectionView,
  CarrierLocationView,
  CarrierRegistryEntry,
  CarrierTestResult,
  ConnectedCarrierView
} from './carrier-connections.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(connectionIdSchema)

// Settings → Carriers (TDD_17 §6): the carrier connections of the store in X-Store-Id. Reading them needs SHIPPING_VIEW;
// connecting, editing, testing and disconnecting, SETTINGS_MANAGE_CARRIERS. The store is the one TenantGuard resolved, never
// a value of the request.
@Controller()
export class CarrierConnectionsController {
  constructor(private readonly connections: CarrierConnectionsService) {}

  // Declared before the routes with an id: `registry` is not the id of a connection
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.carriers.registry)
  registry(@CurrentStore() store: Store): Promise<CarrierRegistryEntry[]> {
    return this.connections.registryOf(store.id)
  }

  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.carriers.list)
  list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listCarriersQuerySchema)) query: ListCarriersQuery
  ): Promise<CursorPage<CarrierConnectionView>> {
    return this.connections.list(store.id, query)
  }

  // The places the carrier lists for the address of a guide, under one parent or at the top (the dialog of a guide of a carrier that
  // needs ids of places). Reading them needs SHIPPING_VIEW, like the connection they belong to
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.carriers.locations(':id'))
  locations(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Query(new ZodValidationPipe(listLocationsQuerySchema)) query: ListLocationsQuery
  ): Promise<CarrierLocationView[]> {
    return this.connections.locations(store.id, connectionId, query)
  }

  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.carriers.byId(':id'))
  get(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<CarrierConnectionView> {
    return this.connections.get(store.id, connectionId)
  }

  // The answer holds the secret of the webhook, once: nothing may keep a copy of it
  @NoStore()
  @RequirePermissions(Permissions.SETTINGS_MANAGE_CARRIERS)
  @Post(ApiRoutes.carriers.create)
  @HttpCode(HttpStatusCodes.CREATED)
  connect(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(connectCarrierSchema)) body: ConnectCarrierBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ConnectedCarrierView> {
    return this.connections.connect(store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_CARRIERS)
  @Patch(ApiRoutes.carriers.byId(':id'))
  @HttpCode(HttpStatusCodes.OK)
  update(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) connectionId: string,
    @Body(new ZodValidationPipe(updateCarrierSchema)) body: UpdateCarrierBody,
    @Req() req: AuthenticatedRequest
  ): Promise<CarrierConnectionView> {
    return this.connections.update(store.id, connectionId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_CARRIERS)
  @Post(ApiRoutes.carriers.test(':id'))
  @HttpCode(HttpStatusCodes.OK)
  test(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<CarrierTestResult> {
    return this.connections.test(store.id, connectionId)
  }

  // The answer holds the new secret, once: nothing may keep a copy of it
  @NoStore()
  @RequirePermissions(Permissions.SETTINGS_MANAGE_CARRIERS)
  @Post(ApiRoutes.carriers.webhookSecret(':id'))
  @HttpCode(HttpStatusCodes.OK)
  rotateWebhookSecret(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) connectionId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<{ webhookSecret: string }> {
    return this.connections.rotateWebhookSecret(store.id, connectionId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_CARRIERS)
  @Post(ApiRoutes.carriers.disconnect(':id'))
  @HttpCode(HttpStatusCodes.OK)
  disconnect(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) connectionId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CarrierConnectionView> {
    return this.connections.disconnect(store.id, connectionId, actorOf(user, store, req))
  }
}
