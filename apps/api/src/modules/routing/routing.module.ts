import { Module } from '@nestjs/common'

import { RoutingService } from '@platform/core/messaging'

import { ChannelRegistryModule } from '../channel-registry'
import { ConversationsModule } from '../conversations'
import { TenancyModule } from '../tenancy'

import { RoutingRulesController } from './routing-rules.controller'
import { RoutingRulesService } from './routing-rules.service'

// Needs the database, audit and logger modules of the app. RoutingService is exported for the
// inbound pipeline (Step 2.6).
@Module({
  imports: [ChannelRegistryModule, TenancyModule, ConversationsModule],
  controllers: [RoutingRulesController],
  providers: [RoutingRulesService, RoutingService],
  exports: [RoutingService]
})
export class RoutingModule {}
