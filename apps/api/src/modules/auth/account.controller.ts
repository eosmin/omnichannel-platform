import { Body, Controller, Delete, Get, Patch, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { AuthenticatedUser } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { SkipTenant } from '../tenancy'

import {
  type AccountActor,
  type AccountPreferencesView,
  AccountSettingsService,
  type ProfileView
} from './account-settings.service'
import {
  type UpdateAccountPreferencesBody,
  updateAccountPreferencesSchema,
  type UpdateProfileBody,
  updateProfileSchema
} from './account.schemas'

const actorOf = (user: AuthenticatedUser, req: AuthenticatedRequest): AccountActor => ({
  userId: user.id,
  ipAddress: req.ip,
  userAgent: req.get('user-agent')
})

// The account of whoever holds the access token: a person's own name, picture and preferences. It
// belongs to the person, not to a store, so there is no X-Store-Id and no permission to hold; the
// id is the token's and never comes from the request.
@SkipTenant()
@Controller()
export class AccountController {
  constructor(private readonly settings: AccountSettingsService) {}

  @NoStore()
  @Get(ApiRoutes.account.profile)
  profile(@CurrentUser() user: AuthenticatedUser): Promise<ProfileView> {
    return this.settings.profile(user.id)
  }

  @Patch(ApiRoutes.account.profile)
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ProfileView> {
    return this.settings.updateProfile(user.id, body, actorOf(user, req))
  }

  // The picture goes: the same change as `PATCH` with a null id, on a route of its own
  @Delete(ApiRoutes.account.avatar)
  removeAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<ProfileView> {
    return this.settings.updateProfile(user.id, { avatarMediaId: null }, actorOf(user, req))
  }

  @NoStore()
  @Get(ApiRoutes.account.preferences)
  preferences(@CurrentUser() user: AuthenticatedUser): Promise<AccountPreferencesView> {
    return this.settings.preferences(user.id)
  }

  @Patch(ApiRoutes.account.preferences)
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateAccountPreferencesSchema))
    body: UpdateAccountPreferencesBody,
    @Req() req: AuthenticatedRequest
  ): Promise<AccountPreferencesView> {
    return this.settings.updatePreferences(user.id, body, actorOf(user, req))
  }
}
