import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import type { QueueName } from '@platform/core/queues'

export interface CapturedJob {
  name: string
  data: unknown
  opts?: { jobId?: string }
}

// Stands in for a queue of the app: the suite reads what was queued, and nothing reaches the Redis of
// development (where a worker, if one is running, would take it)
export class CapturedQueue {
  readonly jobs: CapturedJob[] = []

  add(name: string, data: unknown, opts?: { jobId?: string }): Promise<void> {
    this.jobs.push(opts === undefined ? { name, data } : { name, data, opts })
    return Promise.resolve()
  }

  // What the sweep asks of the real queue: nothing was ever queued for it to find
  getJob(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  addBulk(jobs: CapturedJob[]): Promise<void> {
    this.jobs.push(...jobs)
    return Promise.resolve()
  }
}

export function queueOf(app: INestApplication, name: QueueName): CapturedQueue {
  return app.get<CapturedQueue>(getQueueToken(name), { strict: false })
}
