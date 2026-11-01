import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { AuthenticatedUser } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import {
  confirmUploadSchema,
  type ConfirmUploadBody,
  requestUploadUrlSchema,
  type MediaUrls,
  type RequestUploadUrlBody,
  type UploadUrlResult
} from '@platform/core/storage'

import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { type MediaView, MediaService } from './media.service'

type Store = ResolvedTenant['store']

@Controller()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @RequirePermissions(Permissions.MEDIA_UPLOAD)
  @Post(ApiRoutes.media.uploadUrl)
  @HttpCode(HttpStatusCodes.OK)
  uploadUrl(
    @CurrentStore() store: Store,
    @Body(new ZodValidationPipe(requestUploadUrlSchema)) body: RequestUploadUrlBody
  ): Promise<UploadUrlResult> {
    return this.media.requestUploadUrl(store.id, body)
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
}
