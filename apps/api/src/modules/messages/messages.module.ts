import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import { MessagesService, OutboundQueue } from '@platform/core/messaging'

import { ConversationsModule } from '../conversations'
import { MessagingWindowModule } from '../messaging-window'
import { TenancyModule } from '../tenancy'

import { MessagesController } from './messages.controller'

@Module({
  imports: [TenancyModule, ConversationsModule, MessagingWindowModule, QueuesPlatformModule],
  controllers: [MessagesController],
  providers: [MessagesService, OutboundQueue]
})
export class MessagesModule {}
