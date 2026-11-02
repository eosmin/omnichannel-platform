import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { AccountSettingsService } from './account-settings.service'
import { AccountController } from './account.controller'
import { AccountService } from './account.service'
import { AuthController } from './auth.controller'
import { MagicLinkService } from './magic-link.service'
import { SessionService } from './session.service'

// SessionService is exported for the invitation accept of Step 1.4, which logs in through it too
@Module({
  imports: [QueuesPlatformModule],
  controllers: [AuthController, AccountController],
  providers: [SessionService, MagicLinkService, AccountService, AccountSettingsService],
  exports: [SessionService]
})
export class AuthModule {}
