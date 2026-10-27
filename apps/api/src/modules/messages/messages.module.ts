import { Module } from '@nestjs/common'

import { MessagesService } from '@platform/core/messaging'

import { ConversationsModule } from '../conversations'
import { MessagingWindowModule } from '../messaging-window'
import { TenancyModule } from '../tenancy'

import { MessagesController } from './messages.controller'

@Module({
  imports: [TenancyModule, ConversationsModule, MessagingWindowModule],
  controllers: [MessagesController],
  providers: [MessagesService]
})
export class MessagesModule {}
