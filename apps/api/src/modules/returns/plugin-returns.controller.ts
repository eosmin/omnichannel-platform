import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  type PluginReceptionBatchSummaryView,
  type PluginReceptionBatchView,
  type PluginReturnPage,
  type PluginReturnView,
  pluginReceptionBatchSummaryView,
  pluginReceptionBatchView,
  pluginReturnPage,
  pluginReturnView
} from './plugin-returns.views'
import { ReturnReceptionService } from './return-reception.service'
import { ReturnsQueries } from './returns.queries'
import {
  type ListReceptionBatchesQuery,
  listReceptionBatchesQuerySchema,
  type ListReturnsQuery,
  listReturnsQuerySchema,
  receptionIdSchema,
  returnIdSchema
} from './returns.schemas'

type Store = ResolvedTenant['store']

const READ = PluginScopes.RETURNS_READ

// The returns of the store of the key, and the batches of the scanner that receives them, read only (Step 5.6 PR E6, TDD_17 §4.11
// and §4.16), over the same services as the screen. The store is the one the guard resolved from the key, never one from the
// request, and every query filters by it: a return or a batch of another store is a 404. The ids of the people of the team and the
// flags on a customer are not answered (`plugin-returns.views.ts`). The writes (create, approve, reject, cancel, in transit,
// receive, complete, the return guide, and the scanner's own) store the id of a person, put stock back and may make an order or a
// guide that costs money, so they wait for PR E6-2 and the plugin actor.
@Controller()
export class PluginReturnsController {
  constructor(
    private readonly queries: ReturnsQueries,
    private readonly reception: ReturnReceptionService
  ) {}

  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(PluginApiRoutes.returns.list)
  async list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listReturnsQuerySchema)) query: ListReturnsQuery
  ): Promise<PluginReturnPage> {
    return pluginReturnPage(await this.queries.list(store.id, query))
  }

  // Declared before the route of one return, which would take "reception" for an id
  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(PluginApiRoutes.returns.reception.batches)
  async listBatches(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listReceptionBatchesQuerySchema)) query: ListReceptionBatchesQuery
  ): Promise<PluginReceptionBatchSummaryView[]> {
    const batches = await this.reception.listBatches(store.id, query.status)
    return batches.map(pluginReceptionBatchSummaryView)
  }

  // A plugin holds no permission to flag a customer, so the batch is read with none: nothing that depends on one is in the answer
  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(PluginApiRoutes.returns.reception.batchById(':id'))
  async getBatch(
    @CurrentStore() store: Store,
    @Param('id', new ZodValidationPipe(receptionIdSchema)) batchId: string
  ): Promise<PluginReceptionBatchView> {
    return pluginReceptionBatchView(await this.reception.getBatch(store.id, batchId, []))
  }

  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(PluginApiRoutes.returns.byId(':id'))
  async get(
    @CurrentStore() store: Store,
    @Param('id', new ZodValidationPipe(returnIdSchema)) returnId: string
  ): Promise<PluginReturnView> {
    return pluginReturnView(await this.queries.get(store.id, returnId))
  }
}
