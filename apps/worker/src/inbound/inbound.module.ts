import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'
import {
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  InboundMessageService,
  RoutingService
} from '@platform/core/messaging'

import { ChannelReceipts } from '../outbound/channel-receipts.service'
import { MessageStatusWriter } from '../outbound/message-status.writer'
import { InboundProcessor } from '../processors/inbound.processor'
import { ProcessorSupport } from '../processors/processor-support'

// The database, the event bus and the logger come from the platform module of the worker. The queue
// of the heavy jobs is where the media of a message is sent to be fetched.
@Module({
  imports: [QueuesPlatformModule],
  providers: [
    ProcessorSupport,
    ChannelConnectionResolver,
    CustomerIdentityService,
    ConversationsService,
    RoutingService,
    InboundMessageService,
    MessageStatusWriter,
    ChannelReceipts,
    InboundProcessor
  ]
})
export class InboundModule {}
