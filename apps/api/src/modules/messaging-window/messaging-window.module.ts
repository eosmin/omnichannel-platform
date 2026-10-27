import { Module } from '@nestjs/common'

import { PluginRegistry } from '@platform/plugins/runtime'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { MessagingWindowController } from './messaging-window.controller'
import {
  MESSAGING_WINDOW_POLICIES,
  type MessagingWindowPolicySource
} from './messaging-window.policy'
import { MessagingWindowService } from './messaging-window.service'

// Needs the database module of the app. MessagingWindowService is exported for the messages module
// and, later, for the outbound processor.
@Module({
  imports: [TenancyModule, ChannelRegistryModule],
  controllers: [MessagingWindowController],
  providers: [
    MessagingWindowService,
    {
      provide: MESSAGING_WINDOW_POLICIES,
      // The plugin owns its policy; a channel with none, or one that is not registered any more, has
      // no window
      useFactory: (registry: PluginRegistry): MessagingWindowPolicySource => ({
        policyFor: channelId => registry.find(channelId)?.messagingWindow ?? null
      }),
      inject: [PluginRegistry]
    }
  ],
  exports: [MessagingWindowService, MESSAGING_WINDOW_POLICIES]
})
export class MessagingWindowModule {}
