import { Controller, Get, Param, Query, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentOrganization, CurrentStore, pluginActorOf, RequireAnyPermission } from '../tenancy'

import {
  type CountLinesQuery,
  countLinesQuerySchema,
  idSchema,
  type ListCountsQuery,
  listCountsQuerySchema
} from './counts.schemas'
import { CountsService } from './counts.service'
import {
  type PluginCountDetailView,
  pluginCountDetailView,
  type PluginCountPage,
  pluginCountPage
} from './plugin-counts.views'

const READ = PluginScopes.COUNTS_READ

// The physical counts, read only (Step 5.6 PR E4b, TDD_16 §1, §6), over the same service as the screen. The organization is the
// one the guard resolved from the key, never one from the request. A key is bound to ONE store: it reaches the counts limited to that
// store and the ones of the whole warehouse that have a line of it (`reachableCount`), and reads only the lines of its store; a
// count limited to another store is a count that does not exist for it (404). The ids of the people who opened and approved a count
// are not answered (`plugin-counts.views.ts`). The writes (create, start, count lines, submit, reopen, apply, cancel) are not
// here: they store the id of a person and applying one writes the stock, so they wait for PR E4b-2 and the plugin actor.
@Controller()
export class PluginCountsController {
  constructor(private readonly counts: CountsService) {}

  @PluginApi(READ)
  @RequireAnyPermission(Permissions.INVENTORY_MANAGE_COUNTS, Permissions.INVENTORY_APPLY_COUNTS)
  @Get(PluginApiRoutes.counts.list)
  async list(
    @CurrentOrganization() organization: { id: string },
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string },
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
    @CurrentPluginInstallation() installation: { id: string },
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
}
