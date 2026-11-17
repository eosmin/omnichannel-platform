import { Controller, Get, Param } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { uuidSchema } from '@platform/core/domain'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import {
  MessagingWindowService,
  type MessagingWindowState,
  type Viewer
} from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginViewer, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, RequirePermissions } from '../tenancy'

// Whether the customer of a conversation can still be written to freely (Step 5.6 PR E1): the same service as the inbox, for
// the viewer `plugin:<installation id>`, so a conversation the plugin may not see is a 404
@Controller()
export class PluginMessagingWindowController {
  constructor(private readonly window: MessagingWindowService) {}

  @PluginApi(PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @NoStore()
  @Get(PluginApiRoutes.conversations.messagingWindow(':id'))
  get(
    @CurrentStore() store: { id: string },
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', new ZodValidationPipe(uuidSchema)) conversationId: string
  ): Promise<MessagingWindowState> {
    return this.window.get(store.id, conversationId, viewer)
  }
}
