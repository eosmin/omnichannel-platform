import { Logger, Module, type OnModuleInit } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { QueuesModule, queuePrefixFor } from '@platform/core/queues-module'

const queuePrefix = queuePrefixFor(env.DATABASE_URL, env.QUEUE_PREFIX)

// The queues of the platform, connected from the validated env. The api imports it to enqueue and
// the worker to consume. The apps never read the env themselves.
@Module({
  imports: [
    QueuesModule.forRoot({ redisUrl: env.REDIS_QUEUE_URL ?? env.REDIS_URL, prefix: queuePrefix })
  ],
  exports: [QueuesModule]
})
export class QueuesPlatformModule implements OnModuleInit {
  // The api and the worker must show the same prefix: if they differ, the jobs of the api wait in a
  // queue that no worker reads. Not a secret (it is a hash of the database name).
  onModuleInit(): void {
    new Logger(QueuesPlatformModule.name).log(`queues use the key prefix ${queuePrefix}`)
  }
}
