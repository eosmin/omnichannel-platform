import { Module } from '@nestjs/common'

import { PushPlatformModule, QueuesPlatformModule } from '@platform/core/http'

import { NotificationsProcessor } from '../processors/notifications.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { WebPushSender } from './web-push-sender.service'
import { WebPushGateway } from './web-push.gateway'

// The database and the logger come from the platform module of the worker
@Module({
  imports: [QueuesPlatformModule, PushPlatformModule],
  providers: [ProcessorSupport, WebPushGateway, WebPushSender, NotificationsProcessor]
})
export class NotificationsModule {}
