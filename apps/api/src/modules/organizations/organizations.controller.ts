import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions
} from '../tenancy'

import {
  type CreateStoreBody,
  createStoreSchema,
  idSchema,
  type UpdateOrganizationBody,
  updateOrganizationSchema,
  type UpdateStoreBody,
  updateStoreSchema
} from './organizations.schemas'
import {
  type OrganizationView,
  OrganizationsService,
  type StoreView
} from './organizations.service'

// The organization is the one of the store in X-Store-Id (TenantGuard puts it on the request), and
// the stores listed and changed are its stores: there is no way to name another organization.
@Controller()
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.organizations.current)
  current(@CurrentOrganization() organization: { id: string }): Promise<OrganizationView> {
    return this.organizations.getOrganization(organization.id)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Patch(ApiRoutes.organizations.current)
  update(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganizationBody,
    @Req() req: AuthenticatedRequest
  ): Promise<OrganizationView> {
    return this.organizations.updateOrganization(organization.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.ORG_MANAGE_STORES)
  @Get(ApiRoutes.organizations.stores)
  listStores(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<StoreView[]> {
    return this.organizations.listStores(organization.id, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.ORG_MANAGE_STORES)
  @Post(ApiRoutes.organizations.stores)
  @HttpCode(HttpStatusCodes.CREATED)
  createStore(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(createStoreSchema)) body: CreateStoreBody,
    @Req() req: AuthenticatedRequest
  ): Promise<StoreView> {
    return this.organizations.createStore(organization.id, body, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.ORG_MANAGE_STORES)
  @Get(ApiRoutes.organizations.storeById(':id'))
  getStore(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<StoreView> {
    return this.organizations.getStore(organization.id, id, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.ORG_MANAGE_STORES)
  @Patch(ApiRoutes.organizations.storeById(':id'))
  updateStore(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(updateStoreSchema)) body: UpdateStoreBody,
    @Req() req: AuthenticatedRequest
  ): Promise<StoreView> {
    return this.organizations.updateStore(organization.id, id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.ORG_MANAGE_STORES)
  @Delete(ApiRoutes.organizations.storeById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async deleteStore(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.organizations.deleteStore(organization.id, id, actorOf(user, store, req))
  }
}
