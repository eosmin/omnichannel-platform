import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { FiscalAnnexHeaders } from '@platform/core/domain'
import { ExportContentTypes } from '@platform/core/exports'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  NoTenantTransaction,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { FiscalAnnexExportService } from './fiscal-annex-export.service'
import { type AnnexQuery, annexIdSchema, annexQuerySchema } from './fiscal.schemas'

interface Organization {
  id: string
}

// The annexes of the monthly return as the tax authority loads them (D4a). Taking the file out needs the permission of the fiscal documents
// and the two of the financial files (the same as the VAT file), the person must read the documents of every store (the service checks it),
// and the file is never kept by a cache.
@Controller()
export class FiscalAnnexController {
  constructor(private readonly exporter: FiscalAnnexExportService) {}

  @RequirePermissions(Permissions.FISCAL_VIEW, Permissions.FINANCE_VIEW, Permissions.FINANCE_EXPORT)
  @NoStore()
  @NoTenantTransaction(
    'reads the documents of every store of the organization: the service opens the context of the organization itself, because the one of the request holds the store of the header alone'
  )
  @Get(ApiRoutes.fiscal.annex(':id'))
  async annex(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(annexIdSchema)) annexId: string,
    @Query(new ZodValidationPipe(annexQuerySchema)) query: AnnexQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const file = await this.exporter.export(
      organization.id,
      annexId,
      query,
      actorOf(user, store, req)
    )
    res.setHeader('Content-Type', ExportContentTypes.CSV)
    // The name is the provider's and has only letters, digits, dashes and one dot
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('Cache-Control', 'no-store')
    // What the file leaves out on purpose, counted (never named): the accountant sees it
    const notices = Object.entries(file.notices ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
    if (notices.length > 0) {
      res.setHeader(
        FiscalAnnexHeaders.NOTICES,
        notices.map(([code, count]) => `${code}=${count}`).join(',')
      )
    }
    return file.content
  }
}
