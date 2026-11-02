import { Body, Controller, HttpCode, Post } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { AuthenticatedUser } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import { type UploadUrlResult } from '@platform/core/storage'

import { SkipTenant } from '../tenancy'

import { type AvatarUploadView, AvatarUploadsService } from './avatar-uploads.service'
import {
  type ConfirmAvatarUploadBody,
  confirmAvatarUploadSchema,
  type RequestAvatarUploadBody,
  requestAvatarUploadSchema
} from './avatar.schemas'

// The upload of one's own picture. It belongs to the person, not to a store: there is no X-Store-Id
// and no permission to hold (a Viewer sets a picture too), the id is the token's and never comes from
// the request, and the quota is the person's own. Attaching the uploaded file as the picture is
// `PATCH /account/profile`, and so is taking it away (a null id).
@SkipTenant()
@Controller()
export class AvatarController {
  constructor(private readonly avatars: AvatarUploadsService) {}

  @Post(ApiRoutes.account.avatarUploadUrl)
  @HttpCode(HttpStatusCodes.OK)
  uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(requestAvatarUploadSchema)) body: RequestAvatarUploadBody
  ): Promise<UploadUrlResult> {
    return this.avatars.requestUploadUrl(user.id, body)
  }

  @Post(ApiRoutes.account.avatarConfirm)
  @HttpCode(HttpStatusCodes.OK)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(confirmAvatarUploadSchema)) body: ConfirmAvatarUploadBody
  ): Promise<AvatarUploadView> {
    return this.avatars.confirmUpload(user.id, body)
  }
}
