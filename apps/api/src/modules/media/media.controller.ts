import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import {
  confirmUploadSchema,
  downloadAllBodySchema,
  type DownloadAllBody,
  type ConfirmUploadBody,
  requestUploadUrlSchema,
  type MediaUrls,
  type RequestUploadUrlBody,
  type UploadUrlResult
} from '@platform/core/storage'

import type { ExportView } from '../exports'
import {
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { MediaDownloadService } from './media-download.service'
import { type MediaView, MediaService } from './media.service'

type Store = ResolvedTenant['store']

@Controller()
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly downloads: MediaDownloadService
  ) {}

  @RequirePermissions(Permissions.MEDIA_UPLOAD)
  @Post(ApiRoutes.media.uploadUrl)
  @HttpCode(HttpStatusCodes.OK)
  uploadUrl(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(requestUploadUrlSchema)) body: RequestUploadUrlBody
  ): Promise<UploadUrlResult> {
    return this.media.requestUploadUrl(store.id, user.id, body)
  }

  @RequirePermissions(Permissions.MEDIA_UPLOAD)
  @Post(ApiRoutes.media.confirmUpload)
  @HttpCode(HttpStatusCodes.OK)
  confirmUpload(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(confirmUploadSchema)) body: ConfirmUploadBody
  ): Promise<MediaView> {
    return this.media.confirmUpload(store.id, user.id, body)
  }

  @RequirePermissions(Permissions.MEDIA_VIEW)
  @Get(ApiRoutes.media.byId(':id'))
  urls(
    @CurrentStore() store: Store,
    @Param('id', new ParseUUIDPipe()) id: string
  ): Promise<MediaUrls> {
    return this.media.urlsFor(store.id, id)
  }

  // "Download all" of the gallery of a customer: 202 and the export to follow in the exports center
  @RequirePermissions(
    Permissions.CUSTOMERS_VIEW,
    Permissions.MEDIA_VIEW,
    Permissions.MEDIA_DOWNLOAD_ALL
  )
  @Post(ApiRoutes.media.downloadAll)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  downloadAll(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(downloadAllBodySchema)) body: DownloadAllBody
  ): Promise<ExportView> {
    return this.downloads.requestZip(store.id, user.id, held, body)
  }
}
