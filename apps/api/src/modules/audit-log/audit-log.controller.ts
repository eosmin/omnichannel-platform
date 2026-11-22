import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import type { CursorPage } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import type { ExportView } from '../exports'
import { actorOf, CurrentStore, RequirePermissions } from '../tenancy'

import {
  type AuditLogEntryQuery,
  auditLogEntryQuerySchema,
  type ExportAuditLogQuery,
  exportAuditLogQuerySchema,
  type ListAuditLogQuery,
  listAuditLogQuerySchema
} from './audit-log.schemas'
import { AuditLogService } from './audit-log.service'
import type { AuditLogEntryView } from './audit-log.views'

// The audit log of the store in X-Store-Id (TDD_05 §9.3). The permission is organization-level, the rows are the store's: an entry
// with no store belongs to no tenant and is not listed. Nothing here changes an entry.
@Controller()
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @RequirePermissions(Permissions.ORG_VIEW_AUDIT_LOG)
  @NoStore()
  @Get(ApiRoutes.organizations.auditLog)
  list(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listAuditLogQuerySchema)) query: ListAuditLogQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<CursorPage<AuditLogEntryView>> {
    return this.auditLog.list(store.id, actorOf(user, store, req), query)
  }

  // The file is made in the background: the answer is the export to follow in the exports center
  @RequirePermissions(Permissions.ORG_VIEW_AUDIT_LOG)
  @NoStore()
  @Get(ApiRoutes.organizations.auditLogExport)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  requestExport(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(exportAuditLogQuerySchema)) query: ExportAuditLogQuery
  ): Promise<ExportView> {
    return this.auditLog.requestExport(store.id, user.id, query)
  }

  // Declared after the export: `export` is not an id (and the id is a UUID, or the request is refused)
  @RequirePermissions(Permissions.ORG_VIEW_AUDIT_LOG)
  @NoStore()
  @Get(ApiRoutes.organizations.auditLogEntry(':id'))
  get(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(auditLogEntryQuerySchema)) query: AuditLogEntryQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<AuditLogEntryView> {
    return this.auditLog.get(store.id, actorOf(user, store, req), id, query.at)
  }
}
