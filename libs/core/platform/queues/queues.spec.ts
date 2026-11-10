import { JobNames, QueueNames, reconcileInventoryJobId } from './queue-names'
import { LockNames, Schedules } from './schedules'

describe('QueueNames', () => {
  it('has nine queues plus the dead-letter queue and no AI queue', () => {
    expect(Object.keys(QueueNames)).toHaveLength(10)
    expect(Object.keys(QueueNames)).toContain('DEAD_LETTER')
    expect(Object.keys(QueueNames)).not.toContain('AI')
  })
})

describe('JobNames', () => {
  it('uses unique kebab-case names', () => {
    const names: string[] = Object.values(JobNames)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-z]+(-[a-z0-9]+)*$/)
    }
  })

  it('has no billing, referral or chatbot jobs', () => {
    const forbidden = /(stripe|payout|chatbot)/
    expect(Object.values(JobNames).filter(name => forbidden.test(name))).toEqual([])
  })
})

describe('reconcileInventoryJobId', () => {
  it('is one id for a store and a day, with no colon (BullMQ refuses it)', () => {
    const id = reconcileInventoryJobId('store-1', '2026-11-12')
    expect(id).toBe('reconcile-inventory-store-1-2026-11-12')
    expect(id).not.toContain(':')
    expect(reconcileInventoryJobId('store-2', '2026-11-12')).not.toBe(id)
    expect(reconcileInventoryJobId('store-1', '2026-11-13')).not.toBe(id)
  })
})

describe('Schedules', () => {
  it('uses 5-field cron expressions, except the queue metrics collector (6 fields)', () => {
    for (const [name, cron] of Object.entries(Schedules)) {
      const fields = cron.split(' ').length
      expect(fields).toBe(name === 'COLLECT_QUEUE_METRICS' ? 6 : 5)
    }
  })

  it('keeps the schedules the alerts depend on', () => {
    expect(Schedules.COLLECT_QUEUE_METRICS).toBe('*/15 * * * * *')
    expect(Object.keys(Schedules)).not.toEqual(expect.arrayContaining(['PROCESS_DUNNING']))
  })

  it('runs the daily digest every hour, so each user is reached at their own 08:10', () => {
    expect(Schedules.SEND_EMAIL_DIGEST_DAILY.split(' ')[1]).toBe('*')
  })

  it('derives one lock name per schedule', () => {
    expect(Object.keys(LockNames).sort()).toEqual(Object.keys(Schedules).sort())
    expect(LockNames.WAKE_SNOOZED).toBe('wake_snoozed')
    expect(new Set(Object.values(LockNames)).size).toBe(Object.keys(Schedules).length)
  })
})
