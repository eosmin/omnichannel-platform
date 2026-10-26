import { Controller, Get, Param } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { uuidSchema } from '@platform/core/domain'
import { ZodValidationPipe } from '@platform/core/http'

import { viewerOf } from '../conversations'
import { CurrentPermissions, CurrentStore, RequirePermissions } from '../tenancy'

import { type MessagingWindowState, MessagingWindowService } from './messaging-window.service'

@Controller()
export class MessagingWindowController {
  constructor(private readonly window: MessagingWindowService) {}

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.conversations.messagingWindow(':id'))
  get(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ZodValidationPipe(uuidSchema)) conversationId: string
  ): Promise<MessagingWindowState> {
    return this.window.get(store.id, conversationId, viewerOf(user.id, held))
  }
}
