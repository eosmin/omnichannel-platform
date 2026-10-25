import { getQueueToken } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import type { Queue } from 'bullmq'

import { QueueNames, type QueueName } from '@platform/core/queues'

// What Bull Board, the dead-letter handling and the metrics collector inject, so that no file holds
// its own list of queues.
@Injectable()
export class QueuesRegistry {
  constructor(private readonly moduleRef: ModuleRef) {}

  get(name: QueueName): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false })
  }

  entries(): [QueueName, Queue][] {
    return Object.values(QueueNames).map(name => [name, this.get(name)])
  }
}
