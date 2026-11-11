import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import { OutboundQueue } from '@platform/core/messaging'

import { ChannelRegistryModule } from '../channel-registry'
import { ChannelsModule } from '../channels/channels.module'
import { ConversationsModule } from '../conversations'
import { MessagingWindowModule } from '../messaging-window'
import { TenancyModule } from '../tenancy'

import { OrderMessagesController } from './order-messages.controller'
import { OrderMessagesService } from './order-messages.service'
import { OrderTemplatesController } from './order-templates.controller'
import { OrderTemplatesService } from './order-templates.service'

// Settings → Order messages (TDD_17 §4.7) and the sending of those messages. The service that sends is exported for the
// listeners of the orders (Step 4.9 PR C2b), which ask for the message a status or a shipment calls for.
@Module({
  imports: [
    ChannelRegistryModule,
    ChannelsModule,
    ConversationsModule,
    MessagingWindowModule,
    QueuesPlatformModule,
    TenancyModule
  ],
  controllers: [OrderTemplatesController, OrderMessagesController],
  providers: [OrderTemplatesService, OrderMessagesService, OutboundQueue],
  exports: [OrderTemplatesService, OrderMessagesService]
})
export class OrderMessagesModule {}
