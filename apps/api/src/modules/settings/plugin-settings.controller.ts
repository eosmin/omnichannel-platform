import { Controller, Get } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'

import { type PluginPreferencesView, pluginPreferencesView } from './plugin-settings.views'
import { PreferencesService } from './preferences.service'
import { type ReturnSettingsView, ReturnSettingsService } from './return-settings.service'

// How the store is set up to work, read only (Step 5.6 PR E3a, scope `settings:read`): the preferences (an allowlist: not the approval controls) and the return rules. The
// security settings, the routing, the hours and the inbox behaviour stay human (the map says why), and no setting is written.
@Controller()
export class PluginSettingsController {
  constructor(
    private readonly preferences: PreferencesService,
    private readonly returns: ReturnSettingsService
  ) {}

  @PluginApi(PluginScopes.SETTINGS_READ)
  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(PluginApiRoutes.settings.preferences)
  async getPreferences(@CurrentStore() store: { id: string }): Promise<PluginPreferencesView> {
    return pluginPreferencesView(await this.preferences.get(store.id))
  }

  @PluginApi(PluginScopes.SETTINGS_READ)
  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(PluginApiRoutes.settings.returns)
  getReturns(@CurrentStore() store: { id: string }): Promise<ReturnSettingsView> {
    return this.returns.get(store.id)
  }
}
