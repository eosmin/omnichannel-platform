import { Module } from '@nestjs/common'

import { BullBoardPlatformModule, HttpPlatformModule } from '@platform/core/http'

import { AuthModule } from './modules/auth/auth.module'
import { WebhooksModule } from './modules/webhooks/webhooks.module'

@Module({ imports: [HttpPlatformModule, BullBoardPlatformModule, AuthModule, WebhooksModule] })
export class AppModule {}
