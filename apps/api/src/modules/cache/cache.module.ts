import { Module } from '@nestjs/common'

import { CacheInvalidationListener } from './cache-invalidation.listener'

// Needs the global RedisModule (CacheService) and EventBusModule of the app
@Module({ providers: [CacheInvalidationListener] })
export class CacheInvalidationModule {}
