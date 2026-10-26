import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { ConversationCountsService } from './conversation-counts.service'
import { ConversationTagsService } from './conversation-tags.service'
import { ConversationsController } from './conversations.controller'
import { ConversationsService } from './conversations.service'

// Needs the database module of the app. ConversationsService is exported for the inbound pipeline
// (Step 2.6), which creates the conversation of a message and changes its status.
@Module({
  imports: [TenancyModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationCountsService, ConversationTagsService],
  exports: [ConversationsService]
})
export class ConversationsModule {}
