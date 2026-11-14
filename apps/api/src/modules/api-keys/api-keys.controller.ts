import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { type CreateApiKeyBody, createApiKeySchema, idSchema } from './api-keys.schemas'
import { ApiKeysService } from './api-keys.service'
import type { ApiKeyView, ApiKeyWithTokenView } from './api-keys.views'

type Store = ResolvedTenant['store']

// Settings → API keys of the store in X-Store-Id. A key is a credential: listing, making and revoking them is one permission.
@Controller()
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @RequirePermissions(Permissions.SETTINGS_MANAGE_API_KEYS)
  @Get(ApiRoutes.settings.apiKeys)
  list(@CurrentStore() store: Store): Promise<ApiKeyView[]> {
    return this.keys.list(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_API_KEYS)
  @Post(ApiRoutes.settings.apiKeys)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ApiKeyWithTokenView> {
    return this.keys.create(store.id, body, held, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_MANAGE_API_KEYS)
  @Delete(ApiRoutes.settings.apiKeyById(':id'))
  revoke(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(idSchema)) keyId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<ApiKeyView> {
    return this.keys.revoke(store.id, keyId, actorOf(user, store, req))
  }
}
