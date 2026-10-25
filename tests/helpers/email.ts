import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { QueueNames, type SendEmailJob } from '@platform/core/queues'

// Stands in for the email queue of the app: the suites read what would have been sent, and nothing
// reaches the Redis of development (where a worker, if one is running, would try to send it).
export class CapturedEmails {
  readonly jobs: SendEmailJob[] = []

  add(_name: string, data: SendEmailJob): Promise<void> {
    this.jobs.push(data)
    return Promise.resolve()
  }

  to(address: string): SendEmailJob[] {
    return this.jobs.filter(job => job.to === address)
  }
}

// What the app under test has been asked to send
export function emailsOf(app: INestApplication): CapturedEmails {
  return app.get<CapturedEmails>(getQueueToken(QueueNames.EMAIL), { strict: false })
}
