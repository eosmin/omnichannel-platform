// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one call, or inside the binding it is handed, which the deliverer builds with the same rule
import type { Counter } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'

import type { JobContext, PrismaService, PrismaTransaction } from '@platform/core/database'
import { WebhookLimits } from '@platform/core/domain'
import { PostgresSqlStates } from '@platform/core/errors'
import type { WebhookMetricTargetType } from '@platform/core/metrics'

import { GoneVerdict, judgeGone } from './gone-verdict'
import type { Failure } from './webhook-sending'

// One row of the log of a delivery
export interface DeliveryLogRow {
  event: string
  statusCode: number | null
  durationMs: number
  success: boolean
  // A code of WebhookDeliveryErrors, already cut to what the log keeps
  error?: string
  attempt: number
}

// What differs between the webhooks of a store and the webhooks of a plugin installation: the rows each writes, the counter each
// keeps and what each does when the failures in a row reach the limit. How a delivery is written down, when its parent is deleted
// meanwhile and when the failures turn it off is the recorder's, and is the same for both.
export interface DeliveryBinding {
  readonly target: WebhookMetricTargetType
  // Said in the logs: 'a webhook', 'a plugin installation'
  readonly noun: string
  // Said when the failures in a row turned the subscription off
  readonly disabledMessage: string
  // The id of the subject, named the way the logs and the metrics of its kind name it
  readonly logFields: Readonly<Record<string, string>>
  // Opens the unit of work of the store itself, because it is read again after a refusal that left the first one aborted
  exists(): Promise<boolean>
  // The success: one log row and the count of failures in a row cleared when there is something to clear. Inside the unit of work
  // of the store that the recorder opens.
  writeSuccess(row: DeliveryLogRow): Promise<void>
  writeFailureRow(tx: PrismaTransaction, row: DeliveryLogRow): Promise<void>
  // Stamps the failure and, when `counts`, adds it to the failures in a row; resolves with the count after
  markFailure(tx: PrismaTransaction, counts: boolean): Promise<number>
  // True when this call is the one that turned the subscription off (and then it has told whoever must be told, in `tx`)
  turnOff(tx: PrismaTransaction, consecutiveFailures: number): Promise<boolean>
}

export interface FailureResult {
  failure: Failure
  event: string
  durationMs: number
  attempt: number
  // The delivery is over (no try is left, or none would help): only then does it count toward turning the subscription off
  over: boolean
  // Written to the log and counted toward nothing (the last delivery of a revoked installation: there is nothing left to turn off)
  countless?: boolean
}

// How the deliverers of the worker write a delivery down (TDD_07 §2, TDD_10 §6.5): the metric, the row of the log, the count of
// failures in a row and the turning off, and the end of a delivery whose subscription was deleted while it ran.
export class WebhookDeliveryRecorder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly deliveries: Counter<string>,
    private readonly goneBehindPolicy: Counter<string>,
    private readonly logger: PinoLogger
  ) {}

  async success(
    binding: DeliveryBinding,
    storeId: string,
    row: Omit<DeliveryLogRow, 'success' | 'error'>
  ): Promise<void> {
    this.deliveries.inc({ target: binding.target, success: 'true' })
    // The context is opened inside `guarded`: a subscription deleted meanwhile breaks the transaction, and that is read outside of it
    await this.guarded(binding, storeId, () =>
      this.jobContext.forStore(storeId, () => binding.writeSuccess({ ...row, success: true }))
    )
  }

  // True when this failure was the one that turned the subscription off
  async failure(
    binding: DeliveryBinding,
    storeId: string,
    result: FailureResult
  ): Promise<boolean> {
    const { failure, event, durationMs, attempt, over, countless } = result
    this.deliveries.inc({ target: binding.target, success: 'false' })
    let disabled = false
    await this.guarded(binding, storeId, async () => {
      disabled = await this.jobContext.forStore(storeId, () =>
        this.prisma.transaction(async tx => {
          await binding.writeFailureRow(tx, {
            event,
            statusCode: failure.status,
            durationMs,
            success: false,
            error: failure.code.slice(0, WebhookLimits.DELIVERY_ERROR_MAX_LENGTH),
            attempt
          })
          if (countless === true) return false
          // Every try is a row of the log; only the end of a delivery counts toward turning the subscription off
          const consecutive = await binding.markFailure(tx, over)
          if (!over || consecutive < WebhookLimits.MAX_CONSECUTIVE_FAILURES) return false
          // Only the one that changes it from delivering tells anybody: two deliveries that fail together say it once
          return binding.turnOff(tx, consecutive)
        })
      )
    })
    if (disabled) this.logger.warn({ ...binding.logFields, storeId }, binding.disabledMessage)
    return disabled
  }

  // A subscription deleted while its delivery ran has no log to write to: that is the end of it, not an error to retry. With the
  // policy on, the insert is refused (42501) before the foreign key can fail, so the parent is looked up again in a new unit of work,
  // outside the one that broke: only its absence is a deletion, and a refusal with the parent still there is thrown as it came.
  async guarded(
    binding: DeliveryBinding,
    storeId: string,
    work: () => Promise<void>
  ): Promise<void> {
    try {
      await work()
    } catch (error) {
      const verdict = await judgeGone(error, () => binding.exists())
      if (verdict === GoneVerdict.NOT_GONE) throw error
      if (verdict === GoneVerdict.DELETED_BEHIND_POLICY) {
        this.goneBehindPolicy.inc({ target: binding.target })
        this.logger.warn(
          { ...binding.logFields, storeId, code: PostgresSqlStates.INSUFFICIENT_PRIVILEGE },
          `${binding.noun} was deleted while its delivery ran: the log row was refused by the policy`
        )
        return
      }
      this.logger.info(binding.logFields, `${binding.noun} was deleted while its delivery ran`)
    }
  }
}
