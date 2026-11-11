import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import type { CursorPage } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { connectionIdSchema } from './carrier-connections.schemas'
import {
  type ListStatusMappingsQuery,
  listStatusMappingsQuerySchema,
  type ListUnmappedStatusesQuery,
  listUnmappedStatusesQuerySchema,
  providerCodeSchema,
  type PutStatusMappingBody,
  putStatusMappingSchema
} from './carrier-status-mappings.schemas'
import {
  CarrierStatusMappingsService,
  type StatusMappingView,
  type UnmappedStatusView
} from './carrier-status-mappings.service'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(connectionIdSchema)
const code = () => new ZodValidationPipe(providerCodeSchema)

// Settings → Carriers → Status mapping (TDD_17 §4.17, §6). Reading the rows and the codes that wait needs SHIPPING_VIEW;
// changing a row, SETTINGS_MANAGE_CARRIERS. The store is the one TenantGuard resolved, never a value of the request.
@Controller()
export class CarrierStatusMappingsController {
  constructor(private readonly mappings: CarrierStatusMappingsService) {}

  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.carriers.statusMappings(':id'))
  list(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Query(new ZodValidationPipe(listStatusMappingsQuerySchema)) query: ListStatusMappingsQuery
  ): Promise<CursorPage<StatusMappingView>> {
    return this.mappings.list(store.id, connectionId, query)
  }

  @RequirePermissions(Permissions.SHIPPING_VIEW)
  @Get(ApiRoutes.carriers.unmappedStatuses(':id'))
  listUnmapped(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Query(new ZodValidationPipe(listUnmappedStatusesQuerySchema)) query: ListUnmappedStatusesQuery
  ): Promise<CursorPage<UnmappedStatusView>> {
    return this.mappings.listUnmapped(store.id, connectionId, query)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_CARRIERS)
  @Put(ApiRoutes.carriers.statusMappingByCode(':id', ':code'))
  @HttpCode(HttpStatusCodes.OK)
  put(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) connectionId: string,
    @Param('code', code()) providerCode: string,
    @Body(new ZodValidationPipe(putStatusMappingSchema)) body: PutStatusMappingBody,
    @Req() req: AuthenticatedRequest
  ): Promise<StatusMappingView> {
    return this.mappings.put(store.id, connectionId, providerCode, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_CARRIERS)
  @Delete(ApiRoutes.carriers.statusMappingByCode(':id', ':code'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  remove(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) connectionId: string,
    @Param('code', code()) providerCode: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    return this.mappings.remove(store.id, connectionId, providerCode, actorOf(user, store, req))
  }
}
