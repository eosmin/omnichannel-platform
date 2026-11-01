import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { AuthenticatedUser, Permission } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import type { CursorPage } from '@platform/core/domain'
import { ZodValidationPipe } from '@platform/core/http'

import { CurrentPermissions, CurrentStore, RequireAnyPermission } from '../tenancy'

import { type ListExportsQuery, listExportsQuerySchema } from './exports.schemas'
import { ExportListPermissions, ExportsService } from './exports.service'
import type { ExportDownload, ExportView } from './exports.views'

// The exports center: the files this member asked for, of the kinds their role may make. Making an
// export belongs to the route of what is exported (GET /customers/export, GET /conversations/export,
// POST /media/download-all), each with its own permission.
@RequireAnyPermission(...ExportListPermissions)
@Controller()
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get(ApiRoutes.exports.list)
  list(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(listExportsQuerySchema)) query: ListExportsQuery
  ): Promise<CursorPage<ExportView>> {
    return this.exports.list(store.id, user.id, held, query)
  }

  @Get(ApiRoutes.exports.byId(':id'))
  byId(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ParseUUIDPipe()) id: string
  ): Promise<ExportView> {
    return this.exports.get(store.id, user.id, held, id)
  }

  @Get(ApiRoutes.exports.download(':id'))
  download(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ParseUUIDPipe()) id: string
  ): Promise<ExportDownload> {
    return this.exports.download(store.id, user.id, held, id)
  }
}
