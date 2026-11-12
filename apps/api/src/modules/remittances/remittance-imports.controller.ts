import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common'
import type { Request } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type CreateRemittanceImportProfileBody,
  createRemittanceImportProfileSchema,
  RemittanceImportLimits,
  type RemittanceImportPreviewBody,
  remittanceImportPreviewSchema,
  type RemittanceImportProfilesQuery,
  remittanceImportProfilesQuerySchema,
  type RemittanceImportQuery,
  remittanceImportQuerySchema,
  type UpdateRemittanceImportProfileBody,
  updateRemittanceImportProfileSchema
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { isImportContentType, readImportBody } from './remittance-import-body'
import { type ImportPreviewView, RemittanceImportsService } from './remittance-imports.service'
import {
  RemittanceProfilesService,
  type RemittanceImportProfileView
} from './remittance-profiles.service'
import { remittanceIdSchema } from './remittances.schemas'
import type { RemittanceDetailView } from './remittances.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(remittanceIdSchema)

// The import of a carrier's settlement file and the profiles that read it (TDD_17 §4.15, §6). It is declared before the controller of
// the remittances: `/remittances/import-profiles` must not be taken for the id of a remittance. Reading the profiles asks for
// remittances:view; everything else asks for remittances:manage. The store is the one TenantGuard resolved.
@Controller()
export class RemittanceImportsController {
  constructor(
    private readonly imports: RemittanceImportsService,
    private readonly profiles: RemittanceProfilesService
  ) {}

  @NoStore()
  @RequirePermissions(Permissions.REMITTANCES_VIEW)
  @Get(ApiRoutes.remittances.importProfiles)
  listProfiles(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(remittanceImportProfilesQuerySchema))
    query: RemittanceImportProfilesQuery
  ): Promise<RemittanceImportProfileView[]> {
    return this.profiles.list(store.id, query.connectionId)
  }

  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Post(ApiRoutes.remittances.importProfiles)
  @HttpCode(HttpStatusCodes.CREATED)
  createProfile(
    @CurrentStore() store: Store,
    @Body(new ZodValidationPipe(createRemittanceImportProfileSchema))
    body: CreateRemittanceImportProfileBody
  ): Promise<RemittanceImportProfileView> {
    return this.profiles.create(store.id, body)
  }

  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Patch(ApiRoutes.remittances.importProfileById(':id'))
  updateProfile(
    @CurrentStore() store: Store,
    @Param('id', id()) profileId: string,
    @Body(new ZodValidationPipe(updateRemittanceImportProfileSchema))
    body: UpdateRemittanceImportProfileBody
  ): Promise<RemittanceImportProfileView> {
    return this.profiles.update(store.id, profileId, body)
  }

  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Delete(ApiRoutes.remittances.importProfileById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeProfile(
    @CurrentStore() store: Store,
    @Param('id', id()) profileId: string
  ): Promise<void> {
    await this.profiles.remove(store.id, profileId)
  }

  // The mapper: a sample of the file read with the mapping being tried. It writes nothing
  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Post(ApiRoutes.remittances.importPreview)
  @HttpCode(HttpStatusCodes.OK)
  preview(
    @Body(new ZodValidationPipe(remittanceImportPreviewSchema)) body: RemittanceImportPreviewBody
  ): ImportPreviewView {
    return this.imports.preview(body)
  }

  // The file itself is the body (text/csv, text/tab-separated-values or text/plain, up to 5 MB); the connection and the saved profile
  // that reads it are in the query. Answers 201 with the draft it made; a file with an unreadable row answers 400 and makes nothing.
  @RequirePermissions(Permissions.REMITTANCES_MANAGE)
  @Post(ApiRoutes.remittances.imports)
  @HttpCode(HttpStatusCodes.CREATED)
  async importFile(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(remittanceImportQuerySchema)) query: RemittanceImportQuery,
    @Req() req: AuthenticatedRequest & Request
  ): Promise<RemittanceDetailView> {
    if (!isImportContentType(req.headers['content-type'])) {
      throw new PlatformException(
        ErrorCodes.REMITTANCE_IMPORT_INVALID,
        'the file must be sent as text/csv, text/tab-separated-values or text/plain',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const file = await readImportBody(req, RemittanceImportLimits.MAX_BYTES)
    return this.imports.importFile(store.id, query, file, actorOf(user, store, req))
  }
}
