import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import {
  ConversationClosingService,
  ConversationsService,
  OutboundQueue,
  ReadReceipts,
  RoutingService
} from '@platform/core/messaging'

import { ExportsModule } from '../exports'
import { MessagingWindowModule } from '../messaging-window'
import { TenancyModule } from '../tenancy'
import { WidgetDeliveryModule } from '../widget/widget-delivery.module'

import { ConversationBulkService } from './conversation-bulk.service'
import { ConversationCountsService } from './conversation-counts.service'
import { ConversationOriginsService } from './conversation-origins.service'
import { ConversationTagsService } from './conversation-tags.service'
import { ConversationsController } from './conversations.controller'

// Needs the database module of the app. ConversationsService is exported for the inbound pipeline
// (Step 2.6), which creates the conversation of a message and changes its status.
@Module({
  imports: [
    TenancyModule,
    QueuesPlatformModule,
    ExportsModule,
    MessagingWindowModule,
    WidgetDeliveryModule
  ],
  controllers: [ConversationsController],
  providers: [
    ConversationsService,
    ConversationClosingService,
    ConversationBulkService,
    ConversationCountsService,
    ConversationTagsService,
    ConversationOriginsService,
    OutboundQueue,
    ReadReceipts,
    RoutingService
  ],
  exports: [ConversationsService]
})
export class ConversationsModule {}
