import { Module } from '@nestjs/common'

import { DigestPlatformModule, PushPlatformModule, QueuesPlatformModule } from '@platform/core/http'

import { NotificationsProcessor } from '../processors/notifications.processor'
import { ProcessorSupport } from '../processors/processor-support'

import { EmailDigestService } from './email-digest.service'
import { RemittanceChecker } from './remittance-checker.service'
import { WebPushSender } from './web-push-sender.service'
import { WebPushGateway } from './web-push.gateway'

// The database and the logger come from the platform module of the worker
@Module({
  imports: [QueuesPlatformModule, PushPlatformModule, DigestPlatformModule],
  providers: [
    ProcessorSupport,
    WebPushGateway,
    WebPushSender,
    EmailDigestService,
    RemittanceChecker,
    NotificationsProcessor
  ],
  exports: [EmailDigestService]
})
export class NotificationsModule {}
