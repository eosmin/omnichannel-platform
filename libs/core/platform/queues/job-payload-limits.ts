import { QueueNames, type QueueName } from './queue-names'

const KIB = 1024
const MIB = 1024 * KIB

// The most a processor reads of one job, in bytes of its JSON, per queue. A job crosses Redis, so what reaches the worker is not
// only what our own producers made: a payload past the limit is refused before any schema reads it (a schema would parse all of it
// first), and its copy in the dead-letter queue stays small. Each limit sits above the largest payload the queue is meant to carry.
export const JobPayloadLimits = {
  // A report's file travels as base64 inside the job: the 8 MiB the runner attaches at most is 10.7 MiB of text
  [QueueNames.EMAIL]: 12 * MIB,
  [QueueNames.AUTH_EMAIL]: 64 * KIB,
  // The payload of an event of the store (or of a carrier) with its frame
  [QueueNames.WEBHOOKS]: 2 * MIB,
  [QueueNames.NOTIFICATIONS]: 64 * KIB,
  [QueueNames.ANALYTICS]: 256 * KIB,
  [QueueNames.EXPORTS]: 64 * KIB,
  [QueueNames.HEAVY_PROCESSING]: 512 * KIB,
  // The body of the events of a remote channel is at most 1 MiB (`RemoteChannelLimits.EVENTS_BODY_MAX_BYTES`) and the job adds its frame
  [QueueNames.INBOUND]: 2 * MIB,
  [QueueNames.OUTBOUND]: 64 * KIB,
  [QueueNames.CUSTOMER_PROFILES]: 16 * KIB
} as const satisfies Partial<Record<QueueName, number>>

export type JobQueueName = keyof typeof JobPayloadLimits

// The length of a correlation id of a job: the api makes it a UUID, and the webhook queue narrows it further because it is a header
export const JobCorrelationIdLimits = { MAX_LENGTH: 128 } as const

// True when the JSON of the payload is within the limit of its queue. Only the size is measured: nothing of the payload is read or logged.
export function jobPayloadFits(data: unknown, queue: JobQueueName): boolean {
  // A payload that cannot be written as JSON (a cycle, a bigint) never came out of Redis, so it is not one that fits
  try {
    const text = JSON.stringify(data)
    return text === undefined || Buffer.byteLength(text, 'utf8') <= JobPayloadLimits[queue]
  } catch {
    return false
  }
}

export function hasPayloadLimit(queue: QueueName): queue is JobQueueName {
  return queue in JobPayloadLimits
}
