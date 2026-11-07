import type { DefaultJobOptions } from 'bullmq'

import { CustomerProfileFetch, OutboundLimits } from '@platform/core/domain'
import { QueueNames, type QueueName } from '@platform/core/queues'

const base: DefaultJobOptions = {
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000 }
}

// The backoff of the outbound queue is the worker's own (a throttled send waits longer than any other):
// BullMQ asks the strategy of the worker for the delay of a type it does not know
export const OUTBOUND_BACKOFF_TYPE = 'outbound'

// Retry policy per queue (TDD_07 §1.1). Failed jobs stay in their queue (removeOnFail), which is
// what the Bull Board retry works on; the dead-letter queue only indexes the exhausted ones.
export const QueueJobOptions: Record<QueueName, DefaultJobOptions> = {
  [QueueNames.INBOUND]: { ...base, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
  // 5 attempts from 5 seconds (TDD_10 §6.7.4); from 15 seconds when the provider throttled (OutboundProcessor)
  [QueueNames.OUTBOUND]: {
    ...base,
    attempts: 5,
    backoff: { type: OUTBOUND_BACKOFF_TYPE, delay: OutboundLimits.FAILURE_BACKOFF_MS }
  },
  // A refused read is final and an outage is asked again by the next message: three tries
  [QueueNames.CUSTOMER_PROFILES]: {
    ...base,
    attempts: CustomerProfileFetch.ATTEMPTS,
    backoff: { type: 'exponential', delay: CustomerProfileFetch.BACKOFF_MS }
  },
  [QueueNames.EMAIL]: { ...base, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  [QueueNames.WEBHOOKS]: { ...base, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
  [QueueNames.NOTIFICATIONS]: { ...base, attempts: 5, backoff: { type: 'fixed', delay: 5000 } },
  [QueueNames.ANALYTICS]: { ...base, attempts: 1, delay: 5000 }, // The delay lets nearby events batch
  [QueueNames.EXPORTS]: { ...base, attempts: 3, backoff: { type: 'fixed', delay: 10_000 } },
  [QueueNames.HEAVY_PROCESSING]: {
    ...base,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 }
  },
  [QueueNames.DEAD_LETTER]: { removeOnComplete: false, removeOnFail: false } // Never auto-removed
}
