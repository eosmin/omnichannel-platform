import { Module } from '@nestjs/common'

import { PlatformOriginsPlatformModule } from '@platform/core/http'

import { ConversationsModule } from '../conversations/conversations.module'
import { CustomersModule } from '../customers/customers.module'
import { TenancyModule } from '../tenancy'

import { PluginWidgetsController } from './plugin-widgets.controller'
import { PluginWidgetsService } from './plugin-widgets.service'

// The widgets of the plugins in the agent sidebar (TDD_10 §7)
@Module({
  imports: [ConversationsModule, CustomersModule, PlatformOriginsPlatformModule, TenancyModule],
  controllers: [PluginWidgetsController],
  providers: [PluginWidgetsService]
})
export class PluginWidgetsApiModule {}
