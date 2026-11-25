import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import type { QueueName } from '@platform/core/queues'

export interface CapturedJob {
  name: string
  data: unknown
  opts?: { jobId?: string; delay?: number }
}

// Stands in for a queue of the app: the suite reads what was queued, and nothing reaches the Redis of
// development (where a worker, if one is running, would take it)
export class CapturedQueue {
  readonly jobs: CapturedJob[] = []

  add(name: string, data: unknown, opts?: { jobId?: string; delay?: number }): Promise<void> {
    this.jobs.push(opts === undefined ? { name, data } : { name, data, opts })
    return Promise.resolve()
  }

  // What the sweep asks of the real queue: nothing was ever queued for it to find
  getJob(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  // The schedulers of repeating jobs (the probe of an open contingency): one for each id, asking again is the same one
  readonly schedulers = new Map<string, { every: number; template: CapturedJob }>()

  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: unknown; opts?: { jobId?: string; delay?: number } }
  ): Promise<void> {
    this.schedulers.set(id, { every: repeat.every, template })
    return Promise.resolve()
  }

  removeJobScheduler(id: string): Promise<boolean> {
    return Promise.resolve(this.schedulers.delete(id))
  }

  addBulk(jobs: CapturedJob[]): Promise<void> {
    this.jobs.push(...jobs)
    return Promise.resolve()
  }
}

export function queueOf(app: INestApplication, name: QueueName): CapturedQueue {
  return app.get<CapturedQueue>(getQueueToken(name), { strict: false })
}
