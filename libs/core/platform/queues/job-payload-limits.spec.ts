import { hasPayloadLimit, jobPayloadFits, JobPayloadLimits } from './job-payload-limits'
import { QueueNames } from './queue-names'

describe('the payload limits of the queues', () => {
  it.each(Object.values(QueueNames).filter(queue => queue !== QueueNames.DEAD_LETTER))(
    '%s has a limit (a worker queue without one reads any size)',
    queue => {
      expect(hasPayloadLimit(queue)).toBe(true)
    }
  )

  it('leaves the dead-letter queue without one: nothing reads it as a job', () => {
    expect(hasPayloadLimit(QueueNames.DEAD_LETTER)).toBe(false)
  })

  it('keeps the email limit above the largest file a report attaches, as base64', () => {
    const attachmentBytes = 8 * 1024 * 1024
    expect(JobPayloadLimits[QueueNames.EMAIL]).toBeGreaterThan(Math.ceil((attachmentBytes * 4) / 3))
  })

  it('counts bytes of the JSON, not characters', () => {
    const limit = JobPayloadLimits[QueueNames.CUSTOMER_PROFILES]
    // "é" is two bytes: half the limit in characters is the whole limit in bytes
    const data = { text: 'é'.repeat(limit / 2) }
    expect(jobPayloadFits(data, QueueNames.CUSTOMER_PROFILES)).toBe(false)
    expect(jobPayloadFits({ text: 'a'.repeat(100) }, QueueNames.CUSTOMER_PROFILES)).toBe(true)
  })

  it('does not fit a payload that cannot be written as JSON', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(jobPayloadFits(cycle, QueueNames.OUTBOUND)).toBe(false)
    expect(jobPayloadFits({ n: BigInt(1) }, QueueNames.OUTBOUND)).toBe(false)
  })

  it('fits a payload that is nothing', () => {
    expect(jobPayloadFits(undefined, QueueNames.OUTBOUND)).toBe(true)
  })
})
