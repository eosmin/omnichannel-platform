import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/core/errors'
import {
  type EvaluatePickupsJob,
  evaluatePickupsJobId,
  JobNames,
  LockNames,
  QueueNames,
  Schedules
} from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 55
const MINUTE_MS = 60_000

// Every minute, on one replica: ONE job for every connection (TDD_17 §4.10: schedules cannot be made per tenant row). The minute is
// in the job id, so two ticks of one minute (or two replicas) are one job. What the job does (which connection is due, the reminder,
// the sweep) is `PickupEvaluator`, in the heavy queue, so a slow carrier does not hold the lock.
@Injectable()
export class PickupEvaluateScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly queue: Queue<EvaluatePickupsJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PickupEvaluateScheduler.name)
  }

  @Cron(Schedules.EVALUATE_PICKUPS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.EVALUATE_PICKUPS, LOCK_SECONDS, async () => {
        await this.enqueue(new Date())
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next minute tries again
      this.logger.error({ errorName: errorName(error) }, 'the pickup evaluation was not queued')
    }
  }

  async enqueue(now: Date): Promise<void> {
    const minute = Math.floor(now.getTime() / MINUTE_MS)
    await this.queue.add(
      JobNames.EVALUATE_PICKUPS,
      { minute },
      { jobId: evaluatePickupsJobId(minute), attempts: 1 }
    )
  }
}
