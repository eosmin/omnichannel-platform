import { Module } from '@nestjs/common'

import { ConversationsModule } from '../conversations'
import { TenancyModule } from '../tenancy'

import { RoutingRulesController } from './routing-rules.controller'
import { RoutingRulesService } from './routing-rules.service'
import { RoutingService } from './routing.service'

// Needs the database, audit and logger modules of the app. RoutingService is exported for the
// inbound pipeline (Step 2.6).
@Module({
  imports: [TenancyModule, ConversationsModule],
  controllers: [RoutingRulesController],
  providers: [RoutingRulesService, RoutingService],
  exports: [RoutingService]
})
export class RoutingModule {}
