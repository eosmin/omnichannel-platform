import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import {
  type DeliverInvitationEmailJob,
  JobNames,
  QueueNames,
  type SendEmailJob
} from '@platform/core/queues'

// Stands in for the email queue of the app: the suites read what would have been sent, and nothing
// reaches the Redis of development (where a worker, if one is running, would try to send it).
export class CapturedEmails {
  readonly jobs: SendEmailJob[] = []
  // The requests to deliver the email of an invitation (ids only; the email itself waits sealed in the row)
  readonly deliveries: DeliverInvitationEmailJob[] = []
  private readonly ids = new Set<string>()

  // As the real queue: a job added under an id that a job already has is ignored
  add(
    name: string,
    data: SendEmailJob | DeliverInvitationEmailJob,
    opts?: { jobId?: string }
  ): Promise<void> {
    if (opts?.jobId !== undefined) {
      if (this.ids.has(opts.jobId)) return Promise.resolve()
      this.ids.add(opts.jobId)
    }
    if (name === JobNames.DELIVER_INVITATION_EMAIL)
      this.deliveries.push(data as DeliverInvitationEmailJob)
    else this.jobs.push(data as SendEmailJob)
    return Promise.resolve()
  }

  // Empties the captured jobs and the ids they were added under, as a queue that starts over
  clear(): void {
    this.jobs.length = 0
    this.deliveries.length = 0
    this.ids.clear()
  }

  to(address: string): SendEmailJob[] {
    return this.jobs.filter(job => job.to === address)
  }
}

// What the app under test has been asked to send
export function emailsOf(app: INestApplication): CapturedEmails {
  return app.get<CapturedEmails>(getQueueToken(QueueNames.EMAIL), { strict: false })
}
