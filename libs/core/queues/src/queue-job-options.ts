import type { DefaultJobOptions } from 'bullmq'

import { CustomerProfileFetch } from '@platform/core/domain'
import { QueueNames, type QueueName } from '@platform/core/queues'

const base: DefaultJobOptions = {
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000 }
}

// Retry policy per queue (TDD_07 §1.1). Failed jobs stay in their queue (removeOnFail), which is
// what the Bull Board retry works on; the dead-letter queue only indexes the exhausted ones.
export const QueueJobOptions: Record<QueueName, DefaultJobOptions> = {
  [QueueNames.INBOUND]: { ...base, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
  // 5 attempts from 5 seconds, the same for every plugin (TDD_10 §6.7.4)
  [QueueNames.OUTBOUND]: { ...base, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
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
