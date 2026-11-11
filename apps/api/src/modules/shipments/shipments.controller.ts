import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type CreateShipmentBody,
  createShipmentSchema,
  type CursorPage,
  type SetShipmentStatusBody,
  setShipmentStatusSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  type ListShipmentsQuery,
  listShipmentsQuerySchema,
  shipmentIdSchema
} from './shipments.schemas'
import { ShipmentsService } from './shipments.service'
import type {
  CheckResultView,
  LabelLinkView,
  ShipmentDetailView,
  ShipmentView
} from './shipments.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(shipmentIdSchema)

// The shipments of the store in X-Store-Id (TDD_17 §6). Reading them asks for shipping:view; making a guide, printing its
// label, setting a status, cancelling, checking with the carrier and marking a guide as voided ask for shipping:manage. The
// store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class ShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.shipments.list)
  list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listShipmentsQuerySchema)) query: ListShipmentsQuery
  ): Promise<CursorPage<ShipmentView>> {
    return this.shipments.list(store.id, query)
  }

  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.shipments.byId(':id'))
  get(
    @CurrentStore() store: Store,
    @Param('id', id()) shipmentId: string
  ): Promise<ShipmentDetailView> {
    return this.shipments.get(store.id, shipmentId)
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE)
  @Post(ApiRoutes.shipments.forOrder(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(createShipmentSchema)) body: CreateShipmentBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ShipmentView> {
    return this.shipments.create(store.id, orderId, body, actorOf(user, store, req), held)
  }

  // A link that is good for minutes: nothing may keep a copy of it
  @NoStore()
  @RequirePermissions(Permissions.SHIPPING_MANAGE)
  @Get(ApiRoutes.shipments.label(':id'))
  label(
    @CurrentStore() store: Store,
    @Param('id', id()) shipmentId: string
  ): Promise<LabelLinkView> {
    return this.shipments.label(store.id, shipmentId)
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE)
  @Post(ApiRoutes.shipments.status(':id'))
  @HttpCode(HttpStatusCodes.OK)
  setStatus(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) shipmentId: string,
    @Body(new ZodValidationPipe(setShipmentStatusSchema)) body: SetShipmentStatusBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ShipmentView> {
    return this.shipments.setStatus(store.id, shipmentId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE)
  @Post(ApiRoutes.shipments.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  cancel(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) shipmentId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<ShipmentView> {
    return this.shipments.cancel(store.id, shipmentId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE)
  @Post(ApiRoutes.shipments.check(':id'))
  @HttpCode(HttpStatusCodes.OK)
  check(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) shipmentId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CheckResultView> {
    return this.shipments.check(store.id, shipmentId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SHIPPING_MANAGE)
  @Post(ApiRoutes.shipments.markVoided(':id'))
  @HttpCode(HttpStatusCodes.OK)
  markVoided(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) shipmentId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<ShipmentView> {
    return this.shipments.markVoided(store.id, shipmentId, actorOf(user, store, req))
  }
}
