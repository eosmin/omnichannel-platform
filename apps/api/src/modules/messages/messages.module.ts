import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import {
  AgentReactionsService,
  ChannelConnectionResolver,
  InboundMessageTargets,
  MessageChangesService,
  MessageReactionsService,
  MessagesService,
  OutboundQueue
} from '@platform/core/messaging'

import { ChannelRegistryModule } from '../channel-registry'
import { ConversationsModule } from '../conversations'
import { MessagingWindowModule } from '../messaging-window'
import { TenancyModule } from '../tenancy'

import { MessagesController } from './messages.controller'

@Module({
  imports: [
    TenancyModule,
    ConversationsModule,
    MessagingWindowModule,
    QueuesPlatformModule,
    ChannelRegistryModule
  ],
  controllers: [MessagesController],
  providers: [
    MessagesService,
    ChannelConnectionResolver,
    InboundMessageTargets,
    MessageReactionsService,
    AgentReactionsService,
    MessageChangesService,
    OutboundQueue
  ]
})
export class MessagesModule {}
