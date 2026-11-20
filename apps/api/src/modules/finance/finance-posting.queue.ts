import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { PrismaService } from '@platform/core/database'
import {
  FinanceEventKind,
  FinanceEventSource,
  financePostingJobOptions,
  FinanceSourceType
} from '@platform/core/domain'
import { JobNames, type PostFinanceEventJob, QueueNames } from '@platform/core/queues'

const KINDS: readonly string[] = Object.values(FinanceEventKind)
const SOURCES: readonly string[] = Object.values(FinanceSourceType)

// The one producer of the posting job: the listener of the events and the "post again" route make the same job, with the same options,
// so what the worker's schema checks is what both send. A row whose strings are not an event and a source of the books is refused
// here, not in the worker a minute later.
@Injectable()
export class FinancePostingQueue {
  constructor(
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<PostFinanceEventJob>,
    private readonly prisma: PrismaService
  ) {}

  async enqueue(job: {
    organizationId: string
    sourceType: string
    sourceId: string
    kind: string
    occurredAt?: string
  }): Promise<void> {
    if (!KINDS.includes(job.kind) || !SOURCES.includes(job.sourceType)) {
      throw new RangeError('not an event or a source of the books')
    }
    const kind = job.kind as FinanceEventKind
    const sourceType = job.sourceType as FinanceSourceType
    if (FinanceEventSource[kind] !== sourceType)
      throw new RangeError('the event is of another source')
    // After the REAL commit: the job reads the sale, the return or the transfer that raised the event
    await this.prisma.afterCommitStep(this.prisma.client, () =>
      this.queue.add(
        JobNames.POST_FINANCE_EVENT,
        { ...job, kind, sourceType },
        financePostingJobOptions()
      )
    )
  }
}
