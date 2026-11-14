import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { ApiKeyGuard } from './api-key.guard'
import { ApiKeysController } from './api-keys.controller'
import { ApiKeysService } from './api-keys.service'

// Settings → API keys, and the guard that the routes of the public API use to accept them. Needs the database and audit modules of the app.
@Module({
  imports: [TenancyModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyGuard],
  exports: [ApiKeyGuard]
})
export class ApiKeysModule {}
