import type { PinoLogger } from 'nestjs-pino'

import { JobNames, warnFiscalDeadlinesJobId } from '@platform/core/queues'

import { FiscalDeadlinesScheduler } from './fiscal-deadlines.scheduler'

// The hourly schedule of the fiscal windows (D14b): one job per organization over pages, the same hour asked twice is one job, and the job
// carries an id and nothing else.
describe('FiscalDeadlinesScheduler', () => {
  const logger = {
    setContext: () => undefined,
    info: jest.fn(),
    error: jest.fn()
  } as unknown as PinoLogger
  const orgs = ['org-a', 'org-b', 'org-c'].map(id => ({ id }))

  function build() {
    const addBulk = jest.fn().mockResolvedValue([])
    const findMany = jest.fn().mockImplementation((args: { cursor?: { id: string } }) => {
      const start =
        args.cursor === undefined ? 0 : orgs.findIndex(o => o.id === args.cursor?.id) + 1
      return Promise.resolve(orgs.slice(start, start + 2))
    })
    const scheduler = new FiscalDeadlinesScheduler(
      { withLock: (_n: string, _s: number, work: () => Promise<void>) => work() } as never,
      { addBulk } as never,
      { client: { organization: { findMany } } } as never,
      logger
    )
    return { scheduler, addBulk }
  }

  const jobsOf = (addBulk: jest.Mock) =>
    (
      addBulk.mock.calls as [
        { name: string; data: unknown; opts: { jobId: string; removeOnFail: boolean } }[]
      ][]
    ).flatMap(([page]) => page)

  it('queues one job per organization, over pages, with the hour in the id and only the organization in the data', async () => {
    const { scheduler, addBulk } = build()
    const queued = await scheduler.enqueueAll(new Date('2026-11-22T09:20:00Z'), { pageSize: 2 })
    expect(queued).toBe(3)
    const jobs = jobsOf(addBulk)
    expect(jobs.map(j => j.data)).toEqual(orgs.map(o => ({ organizationId: o.id })))
    expect(jobs.map(j => j.opts.jobId)).toEqual(
      orgs.map(o => warnFiscalDeadlinesJobId(o.id, '2026-11-22-09'))
    )
    expect(jobs.every(j => j.name === JobNames.WARN_FISCAL_DEADLINES && j.opts.removeOnFail)).toBe(
      true
    )
  })

  it('asks for the same job inside one hour and for another one the next hour', async () => {
    const { scheduler, addBulk } = build()
    await scheduler.enqueueAll(new Date('2026-11-22T09:20:00Z'))
    await scheduler.enqueueAll(new Date('2026-11-22T09:50:00Z'))
    await scheduler.enqueueAll(new Date('2026-11-22T10:20:00Z'))
    const ids = jobsOf(addBulk)
      .filter(j => (j.data as { organizationId: string }).organizationId === 'org-a')
      .map(j => j.opts.jobId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('has no colon in the id (the queue forbids it)', () => {
    expect(warnFiscalDeadlinesJobId('org', '2026-11-22-09')).not.toContain(':')
  })
})
