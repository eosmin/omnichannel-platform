import { Module } from '@nestjs/common'

import { HttpPlatformModule } from '@platform/core/http'

import { WebhooksModule } from './modules/webhooks/webhooks.module'

@Module({ imports: [HttpPlatformModule, WebhooksModule] })
export class AppModule {}
