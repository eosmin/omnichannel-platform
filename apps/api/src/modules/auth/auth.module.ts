import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { AccountService } from './account.service'
import { AuthController } from './auth.controller'
import { MagicLinkService } from './magic-link.service'
import { SessionService } from './session.service'

// SessionService is exported for the invitation accept of Step 1.4, which logs in through it too
@Module({
  imports: [QueuesPlatformModule],
  controllers: [AuthController],
  providers: [SessionService, MagicLinkService, AccountService],
  exports: [SessionService]
})
export class AuthModule {}
