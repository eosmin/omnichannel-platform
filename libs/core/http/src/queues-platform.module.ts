import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { QueuesModule } from '@platform/core/queues-module'

// The queues of the platform, connected from the validated env. The api imports it to enqueue and
// the worker to consume. The apps never read the env themselves.
@Module({
  imports: [QueuesModule.forRoot({ redisUrl: env.REDIS_QUEUE_URL ?? env.REDIS_URL })],
  exports: [QueuesModule]
})
export class QueuesPlatformModule {}
