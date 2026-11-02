import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { WEB_PUSH_CONFIG, type WebPushConfig, webPushConfig } from '@platform/core/notifications'

// Web push, configured from the validated env (TDD_06 §7.1)
@Module({
  providers: [{ provide: WEB_PUSH_CONFIG, useFactory: (): WebPushConfig => webPushConfig(env) }],
  exports: [WEB_PUSH_CONFIG]
})
export class PushPlatformModule {}
