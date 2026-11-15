import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import type { CursorPage } from '@platform/core/domain'
import { ZodValidationPipe } from '@platform/core/http'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { pluginExportAudience } from '../plugins/plugin-export-audience'
import { CurrentStore } from '../tenancy'

import { type ListExportsQuery, listExportsQuerySchema } from './exports.schemas'
import { ExportsService } from './exports.service'
import type { ExportDownload, ExportView } from './exports.views'

const READ = PluginScopes.EXPORTS_READ

// The exports centre of a plugin (Step 5.6 PR E7), over the same service as the screen: a plugin reads the files THIS installation asked
// for (`plugin:<installation id>` is the owner of the row, so a person's exports and another installation's are a 404), of the kinds its
// scopes still allow, with the same retention and the same signed link of minutes as a person's (`ExportsService.download`). The store is
// the one of the key, never a value of the request. A person does not see what a plugin asked for: the file is data that left the platform
// for the plugin, and it expires with the others (debt: PR E7-2).
@Controller()
export class PluginExportsController {
  constructor(private readonly exports: ExportsService) {}

  @PluginApi(READ)
  @Get(PluginApiRoutes.exports.list)
  list(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; scopes: readonly string[] },
    @Query(new ZodValidationPipe(listExportsQuerySchema)) query: ListExportsQuery
  ): Promise<CursorPage<ExportView>> {
    const { userId, held } = pluginExportAudience(installation)
    return this.exports.list(store.id, userId, held, query)
  }

  @PluginApi(READ)
  @Get(PluginApiRoutes.exports.byId(':id'))
  byId(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; scopes: readonly string[] },
    @Param('id', new ParseUUIDPipe()) id: string
  ): Promise<ExportView> {
    const { userId, held } = pluginExportAudience(installation)
    return this.exports.get(store.id, userId, held, id)
  }

  @PluginApi(READ)
  @Get(PluginApiRoutes.exports.download(':id'))
  download(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; scopes: readonly string[] },
    @Param('id', new ParseUUIDPipe()) id: string
  ): Promise<ExportDownload> {
    const { userId, held } = pluginExportAudience(installation)
    return this.exports.download(store.id, userId, held, id)
  }
}
