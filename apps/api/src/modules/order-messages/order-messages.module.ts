import { Module } from '@nestjs/common'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { OrderTemplatesController } from './order-templates.controller'
import { OrderTemplatesService } from './order-templates.service'

// Settings → Order messages (TDD_17 §4.7): the templates of the messages a store sends about an order. Sending them is
// Step 4.9 PR C2, which uses the service exported here to find the template of a message.
@Module({
  imports: [ChannelRegistryModule, TenancyModule],
  controllers: [OrderTemplatesController],
  providers: [OrderTemplatesService],
  exports: [OrderTemplatesService]
})
export class OrderMessagesModule {}
