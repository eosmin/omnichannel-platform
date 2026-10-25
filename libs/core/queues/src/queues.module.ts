import { BullModule } from '@nestjs/bullmq'
import { type DynamicModule, Module } from '@nestjs/common'

import { QueueNames } from '@platform/core/queues'

import { QueueJobOptions } from './queue-job-options'
import { QueuesRegistry } from './queues-registry'

export interface QueuesModuleOptions {
  redisUrl: string
  // Namespaces the keys in Redis (BullMQ defaults to "bull"); the integration suites use their own
  prefix?: string
}

// Imported by the api (producers) and by the worker (consumers): only the worker registers
// processors. Queues come from @nestjs/bullmq, never from a module-level `new Queue()`.
@Module({})
export class QueuesModule {
  static forRoot(options: QueuesModuleOptions): DynamicModule {
    const queues = Object.values(QueueNames).map(name =>
      BullModule.registerQueue({ name, defaultJobOptions: QueueJobOptions[name] })
    )
    return {
      module: QueuesModule,
      imports: [
        BullModule.forRoot({
          // BullMQ requires maxRetriesPerRequest: null on its blocking connections
          connection: { url: options.redisUrl, maxRetriesPerRequest: null },
          ...(options.prefix === undefined ? {} : { prefix: options.prefix })
        }),
        ...queues
      ],
      providers: [QueuesRegistry],
      exports: [...queues, QueuesRegistry]
    }
  }
}
