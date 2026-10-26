import { Module } from '@nestjs/common'

import { ConversationsModule } from '../conversations'
import { MessagingWindowModule } from '../messaging-window'
import { TenancyModule } from '../tenancy'

import { MessagesController } from './messages.controller'
import { MessagesService } from './messages.service'

@Module({
  imports: [TenancyModule, ConversationsModule, MessagingWindowModule],
  controllers: [MessagesController],
  providers: [MessagesService]
})
export class MessagesModule {}
