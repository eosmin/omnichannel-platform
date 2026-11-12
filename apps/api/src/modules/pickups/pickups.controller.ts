import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type AddPickupShipmentsBody,
  addPickupShipmentsSchema,
  type CursorPage,
  type RequestPickupBody,
  requestPickupSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { PickupManifest } from '@platform/core/shipping'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  type ListPickupsQuery,
  listPickupsQuerySchema,
  pickupIdSchema,
  pickupShipmentParamsSchema
} from './pickups.schemas'
import { PickupsApiService } from './pickups.service'
import type { PickupRequestView, PickupView } from './pickups.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(pickupIdSchema)

// The pickups of the store in X-Store-Id (TDD_17 §4.10, §6). Reading them asks for shipping:view; requesting, changing, confirming and
// cancelling ask for shipping:manage_pickups. The store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class PickupsController {
  constructor(private readonly pickups: PickupsApiService) {}

  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.pickups.list)
  list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listPickupsQuerySchema)) query: ListPickupsQuery
  ): Promise<CursorPage<PickupView>> {
    return this.pickups.list(store.id, query)
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE_PICKUPS)
  @Post(ApiRoutes.pickups.create)
  @HttpCode(HttpStatusCodes.CREATED)
  request(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(requestPickupSchema)) body: RequestPickupBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PickupRequestView> {
    return this.pickups.request(store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE_PICKUPS)
  @Post(ApiRoutes.pickups.shipments(':id'))
  @HttpCode(HttpStatusCodes.OK)
  add(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) pickupId: string,
    @Body(new ZodValidationPipe(addPickupShipmentsSchema)) body: AddPickupShipmentsBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PickupRequestView> {
    return this.pickups.addShipments(store.id, pickupId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE_PICKUPS)
  @Delete(ApiRoutes.pickups.shipmentById(':id', ':shipmentId'))
  @HttpCode(HttpStatusCodes.OK)
  remove(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param(new ZodValidationPipe(pickupShipmentParamsSchema))
    params: { id: string; shipmentId: string },
    @Req() req: AuthenticatedRequest
  ): Promise<PickupView> {
    return this.pickups.removeShipment(
      store.id,
      params.id,
      params.shipmentId,
      actorOf(user, store, req)
    )
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE_PICKUPS)
  @Post(ApiRoutes.pickups.confirm(':id'))
  @HttpCode(HttpStatusCodes.OK)
  confirm(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) pickupId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PickupView> {
    return this.pickups.confirm(store.id, pickupId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE_PICKUPS)
  @Post(ApiRoutes.pickups.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  cancel(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) pickupId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PickupView> {
    return this.pickups.cancel(store.id, pickupId, actorOf(user, store, req))
  }

  // The list the agent prints for the courier: guide, recipient and packages. It names customers, so it asks for shipping:view
  // like every shipment read, and no shared cache keeps it.
  @NoStore()
  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.pickups.manifest(':id'))
  manifest(
    @CurrentStore() store: Store,
    @Param('id', id()) pickupId: string
  ): Promise<PickupManifest> {
    return this.pickups.manifest(store.id, pickupId)
  }
}
