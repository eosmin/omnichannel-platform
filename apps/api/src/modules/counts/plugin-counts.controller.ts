import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import {
  CurrentOrganization,
  CurrentStore,
  pluginActorOf,
  RequireAnyPermission,
  RequirePermissions
} from '../tenancy'

import { CountsApplyService } from './counts-apply.service'
import {
  type CountLinesQuery,
  countLinesQuerySchema,
  type CreateCountBody,
  createCountSchema,
  idSchema,
  type ListCountsQuery,
  listCountsQuerySchema,
  type UpdateCountLinesBody,
  updateCountLinesSchema
} from './counts.schemas'
import { CountsService } from './counts.service'
import {
  type PluginCountDetailView,
  pluginCountDetailView,
  type PluginCountPage,
  pluginCountPage,
  type PluginCountView,
  pluginCountView
} from './plugin-counts.views'

const READ = PluginScopes.COUNTS_READ
const WRITE = PluginScopes.COUNTS_WRITE
const APPLY = PluginScopes.COUNTS_APPLY

type Installation = { id: string; pluginId: string }
type Organization = { id: string }
type Store = { id: string }

const id = () => new ZodValidationPipe(idSchema)

// The physical counts (Step 5.6 PR E4b reads them, PR E4b-2 writes them; TDD_16 §1, §6), over the same services as the screen. The
// organization is the one the guard resolved from the key, never one from the request. A key is bound to ONE store: it reads the
// counts limited to that store and the ones of the whole warehouse that have a line of it (`reachableCount`), and only the lines of
// its store; a count limited to another store is a count that does not exist for it (404).
//
// The writes: each route names its own scope AND `counts:read` (what it answers is the count as a plugin reads it, and the guard
// needs every scope of the route). `counts:write` opens, counts, submits, reopens and cancels (inventory:manage_counts); applying is
// `counts:apply` (inventory:apply_counts), the one step that moves the stock, a scope of its own as who counts does not approve. A
// plugin opens a count limited to the store of its key (never a count of the whole warehouse, which would snapshot the levels of
// every store) and writes only a count limited to that store: one of the whole warehouse is read only to it (403). The count, the
// movements of stock an apply writes and the audit entry name the plugin (`ActorIdentity`, never a made-up user). The ids of the
// people and of the plugin behind a record are not answered (`plugin-counts.views.ts`).
@Controller()
export class PluginCountsController {
  constructor(
    private readonly counts: CountsService,
    private readonly applying: CountsApplyService
  ) {}

  @PluginApi(READ)
  @RequireAnyPermission(Permissions.INVENTORY_MANAGE_COUNTS, Permissions.INVENTORY_APPLY_COUNTS)
  @Get(PluginApiRoutes.counts.list)
  async list(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Query(new ZodValidationPipe(listCountsQuerySchema)) query: ListCountsQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountPage> {
    return pluginCountPage(
      await this.counts.list(organization.id, query, pluginActorOf(installation, store, req))
    )
  }

  @PluginApi(READ)
  @RequireAnyPermission(Permissions.INVENTORY_MANAGE_COUNTS, Permissions.INVENTORY_APPLY_COUNTS)
  @Get(PluginApiRoutes.counts.byId(':id'))
  async get(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Param('id', new ZodValidationPipe(idSchema)) countId: string,
    @Query(new ZodValidationPipe(countLinesQuerySchema)) query: CountLinesQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountDetailView> {
    return pluginCountDetailView(
      await this.counts.get(
        organization.id,
        pluginActorOf(installation, store, req),
        countId,
        query
      )
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(PluginApiRoutes.counts.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Body(new ZodValidationPipe(createCountSchema)) body: CreateCountBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountView> {
    return pluginCountView(
      await this.counts.create(organization.id, body, pluginActorOf(installation, store, req))
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(PluginApiRoutes.counts.start(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async start(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountView> {
    return pluginCountView(
      await this.counts.start(organization.id, countId, pluginActorOf(installation, store, req))
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Patch(PluginApiRoutes.counts.lines(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async updateLines(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) countId: string,
    @Body(new ZodValidationPipe(updateCountLinesSchema)) body: UpdateCountLinesBody,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountView> {
    return pluginCountView(
      await this.counts.updateLines(
        organization.id,
        countId,
        body,
        pluginActorOf(installation, store, req)
      )
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(PluginApiRoutes.counts.submit(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async submit(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountView> {
    return pluginCountView(
      await this.counts.submit(organization.id, countId, pluginActorOf(installation, store, req))
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(PluginApiRoutes.counts.reopen(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async reopen(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountView> {
    return pluginCountView(
      await this.counts.reopen(organization.id, countId, pluginActorOf(installation, store, req))
    )
  }

  @PluginApi(APPLY, READ)
  @RequirePermissions(Permissions.INVENTORY_APPLY_COUNTS)
  @Post(PluginApiRoutes.counts.apply(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async apply(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountView> {
    return pluginCountView(
      await this.applying.apply(organization.id, countId, pluginActorOf(installation, store, req))
    )
  }

  @PluginApi(WRITE, READ)
  @RequirePermissions(Permissions.INVENTORY_MANAGE_COUNTS)
  @Post(PluginApiRoutes.counts.cancel(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async cancel(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) countId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<PluginCountView> {
    return pluginCountView(
      await this.counts.cancel(organization.id, countId, pluginActorOf(installation, store, req))
    )
  }
}
