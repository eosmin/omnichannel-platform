import type { PinoLogger } from 'nestjs-pino'

import { JobNames, resealCredentialsJobId } from '@platform/core/queues'

import { CredentialsResealScheduler } from './credentials-reseal.scheduler'

// The schedule of the re-seal of the credentials (Step 7.3-S11c): only while a previous key is held, one job per organization (all of them,
// with or without books), the same day asked twice is one job, and the job carries an id and nothing else.
describe('CredentialsResealScheduler', () => {
  const logger = {
    setContext: () => undefined,
    info: jest.fn(),
    error: jest.fn()
  } as unknown as PinoLogger
  const orgs = ['org-a', 'org-b', 'org-c'].map(id => ({ id }))

  function build(enabled: boolean) {
    const addBulk = jest.fn().mockResolvedValue([])
    const findMany = jest.fn().mockImplementation((args: { cursor?: { id: string } }) => {
      const start =
        args.cursor === undefined ? 0 : orgs.findIndex(o => o.id === args.cursor?.id) + 1
      return Promise.resolve(orgs.slice(start, start + 2))
    })
    const scheduler = new CredentialsResealScheduler(
      { withLock: (_n: string, _s: number, work: () => Promise<void>) => work() } as never,
      { addBulk } as never,
      { client: { organization: { findMany } } } as never,
      { enabled } as never,
      logger
    )
    return { scheduler, addBulk, findMany }
  }

  it('queues nothing and reads nothing without a previous key', async () => {
    const { scheduler, addBulk, findMany } = build(false)
    expect(await scheduler.enqueueAll(new Date('2026-11-22T04:45:00Z'))).toBe(0)
    expect(findMany).not.toHaveBeenCalled()
    expect(addBulk).not.toHaveBeenCalled()
  })

  it('queues one job for every organization, over pages, with the day in the id and only the organization in the data', async () => {
    const { scheduler, addBulk } = build(true)
    const queued = await scheduler.enqueueAll(new Date('2026-11-22T04:45:00Z'), { pageSize: 2 })
    expect(queued).toBe(3)
    const jobs = (
      addBulk.mock.calls as [
        { name: string; data: unknown; opts: { jobId: string; removeOnFail: boolean } }[]
      ][]
    ).flatMap(([page]) => page)
    expect(jobs.map(j => j.data)).toEqual(orgs.map(o => ({ organizationId: o.id })))
    expect(jobs.map(j => j.opts.jobId)).toEqual(
      orgs.map(o => resealCredentialsJobId(o.id, '2026-11-22'))
    )
    expect(jobs.every(j => j.name === JobNames.RESEAL_CREDENTIALS && j.opts.removeOnFail)).toBe(
      true
    )
  })
})
