import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { OutboundProcessor } from '../processors/outbound.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { MessageStatusWriter } from './message-status.writer'
import { OutboundSender } from './outbound-sender.service'

// Sending a reply and writing its state. The registry and the context of a connection come from the
// worker module (PluginsModule, ChannelConnectionsLibModule); the database, the event bus and the
// logger from its platform module.
@Module({
  imports: [QueuesPlatformModule],
  providers: [ProcessorSupport, MessageStatusWriter, OutboundSender, OutboundProcessor],
  exports: [MessageStatusWriter]
})
export class OutboundModule {}
