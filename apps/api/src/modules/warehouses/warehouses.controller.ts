import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { WarehouseLinksService } from './warehouse-links.service'
import {
  type CreateWarehouseBody,
  createWarehouseSchema,
  idSchema,
  type ListWarehousesQuery,
  listWarehousesQuerySchema,
  type PutWarehouseStoresBody,
  putWarehouseStoresSchema,
  type UpdateWarehouseBody,
  updateWarehouseSchema
} from './warehouses.schemas'
import { WarehousesService } from './warehouses.service'
import type { WarehousePage, WarehouseView } from './warehouses.views'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The warehouses of the organization of the store in X-Store-Id (TDD_16 §1): the permission is the one the caller
// holds in that store, and the organization is the one TenantGuard resolved from it, never one from the request.
// Reading asks for inventory:view; creating, changing and linking for org:manage_warehouses.
@Controller()
export class WarehousesController {
  constructor(
    private readonly warehouses: WarehousesService,
    private readonly links: WarehouseLinksService
  ) {}

  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(ApiRoutes.warehouses.list)
  list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listWarehousesQuerySchema)) query: ListWarehousesQuery
  ): Promise<WarehousePage> {
    return this.warehouses.list(organization.id, query)
  }

  @RequirePermissions(Permissions.INVENTORY_VIEW)
  @Get(ApiRoutes.warehouses.byId(':id'))
  get(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) warehouseId: string
  ): Promise<WarehouseView> {
    return this.warehouses.get(organization.id, warehouseId)
  }

  @RequirePermissions(Permissions.ORG_MANAGE_WAREHOUSES)
  @Post(ApiRoutes.warehouses.create)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createWarehouseSchema)) body: CreateWarehouseBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WarehouseView> {
    return this.warehouses.create(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.ORG_MANAGE_WAREHOUSES)
  @Patch(ApiRoutes.warehouses.byId(':id'))
  update(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) warehouseId: string,
    @Body(new ZodValidationPipe(updateWarehouseSchema)) body: UpdateWarehouseBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WarehouseView> {
    return this.warehouses.update(organization.id, warehouseId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.ORG_MANAGE_WAREHOUSES)
  @Put(ApiRoutes.warehouses.stores(':id'))
  replaceStores(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) warehouseId: string,
    @Body(new ZodValidationPipe(putWarehouseStoresSchema)) body: PutWarehouseStoresBody,
    @Req() req: AuthenticatedRequest
  ): Promise<WarehouseView> {
    return this.links.replace(organization.id, warehouseId, body, actorOf(user, store, req))
  }
}
