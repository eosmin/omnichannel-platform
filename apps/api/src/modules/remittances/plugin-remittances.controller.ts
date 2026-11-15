import { Controller, Get, Param, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import {
  type RemittancePendingQuery,
  remittancePendingQuerySchema,
  type RemittanceImportProfilesQuery,
  remittanceImportProfilesQuerySchema
} from '@platform/core/domain'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  type PluginRemittanceDetailView,
  type PluginRemittancePage,
  pluginImportProfileView,
  pluginPendingConnectionView,
  pluginRemittanceDetailView,
  pluginRemittancePage
} from './plugin-remittances.views'
import {
  type RemittanceImportProfileView,
  RemittanceProfilesService
} from './remittance-profiles.service'
import {
  type ListRemittancesQuery,
  listRemittancesQuerySchema,
  remittanceIdSchema
} from './remittances.schemas'
import { RemittancesApiService } from './remittances.service'
import type { PendingConnectionView } from './remittances.views'

type Store = ResolvedTenant['store']

const READ = PluginScopes.REMITTANCES_READ

// The remittances of cash collected on delivery of the store of the key, read only (Step 5.6 PR E6, TDD_17 §4.15), over the same
// services as the screen. The store is the one the guard resolved from the key, never one from the request, and every query
// filters by it: a remittance or a profile of another store is a 404. The ids of the people of the team and the imported file are
// not answered (`plugin-remittances.views.ts`). Making a draft, importing a statement, changing its lines, confirming, voiding
// and the import profiles' own writes move money or store the id of a person, so they wait for PR E6-2 and the plugin actor.
// The static routes (`pending`, `import-profiles`) are declared before the one of a remittance by id, which would take them for an id.
@Controller()
export class PluginRemittancesController {
  constructor(
    private readonly remittances: RemittancesApiService,
    private readonly profiles: RemittanceProfilesService
  ) {}

  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(PluginApiRoutes.remittances.list)
  async list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listRemittancesQuerySchema)) query: ListRemittancesQuery
  ): Promise<PluginRemittancePage> {
    return pluginRemittancePage(await this.remittances.list(store.id, query))
  }

  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(PluginApiRoutes.remittances.pending)
  async pending(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(remittancePendingQuerySchema)) query: RemittancePendingQuery
  ): Promise<PendingConnectionView[]> {
    const pending = await this.remittances.pending(store.id, query.connectionId)
    return pending.map(pluginPendingConnectionView)
  }

  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(PluginApiRoutes.remittances.importProfiles)
  async listProfiles(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(remittanceImportProfilesQuerySchema))
    query: RemittanceImportProfilesQuery
  ): Promise<RemittanceImportProfileView[]> {
    const profiles = await this.profiles.list(store.id, query.connectionId)
    return profiles.map(pluginImportProfileView)
  }

  @NoStore()
  @PluginApi(READ)
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(PluginApiRoutes.remittances.byId(':id'))
  async get(
    @CurrentStore() store: Store,
    @Param('id', new ZodValidationPipe(remittanceIdSchema)) remittanceId: string
  ): Promise<PluginRemittanceDetailView> {
    return pluginRemittanceDetailView(await this.remittances.get(store.id, remittanceId))
  }
}
