import { type Job, UnrecoverableError } from 'bullmq'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { JobNames, type RollupJob, type TrackAnalyticsJob } from '@platform/core/queues'

import type { AnalyticsEventWriter } from '../analytics/analytics-event.writer'
import type { AnalyticsRollupService } from '../analytics/analytics-rollup.service'

import { AnalyticsProcessor } from './analytics.processor'
import type { ProcessorSupport } from './processor-support'

const STORE = '11111111-1111-4111-8111-111111111111'

describe('AnalyticsProcessor', () => {
  const write = jest.fn<Promise<boolean>, [TrackAnalyticsJob]>()
  const rollup = jest.fn()
  // The inherited support (logs, metrics, dead letter) is not what is under test: it runs the job
  const support = {
    run: (_queue: string, job: Job, run: (job: Job) => Promise<void>) => run(job)
  }
  const processor = new AnalyticsProcessor(
    support as unknown as ProcessorSupport,
    { write } as unknown as AnalyticsEventWriter,
    { rollup } as unknown as AnalyticsRollupService
  )
  const job = (name: string, data: unknown): Job<TrackAnalyticsJob | RollupJob> =>
    ({ name, data }) as unknown as Job<TrackAnalyticsJob | RollupJob>
  const event: TrackAnalyticsJob = {
    event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
    storeId: STORE,
    data: { type: 'email.opened', template: 'qa', messageId: 'e1' },
    timestamp: '2026-11-03T09:55:00.000Z'
  }

  beforeEach(() => {
    write.mockReset().mockResolvedValue(true)
    rollup.mockReset().mockResolvedValue([])
  })

  it('writes the event of a track-event job', async () => {
    await processor.process(job(JobNames.TRACK_EVENT, event))
    expect(write).toHaveBeenCalledWith(event)
  })

  it('reads a timestamp with an offset and hands it over in UTC', async () => {
    await processor.process(
      job(JobNames.TRACK_EVENT, { ...event, timestamp: '2026-11-03T03:55:00-06:00' })
    )
    expect(write).toHaveBeenCalledWith({ ...event, timestamp: '2026-11-03T09:55:00.000Z' })
  })

  it('hands over only the fields of a track-event job', async () => {
    await processor.process(job(JobNames.TRACK_EVENT, { ...event, extra: 'not ours' }))
    expect(write).toHaveBeenCalledWith(event)
  })

  it('lets a failed write fail the job as it is, so that the queue decides what to do', async () => {
    const failure = new Error('connection lost')
    write.mockRejectedValue(failure)
    const error = await processor.process(job(JobNames.TRACK_EVENT, event)).catch((e: unknown) => e)
    expect(error).toBe(failure)
    expect(error).not.toBeInstanceOf(UnrecoverableError)
  })

  it.each([
    ['a store id that is not a UUID', { ...event, storeId: 'nope' }],
    ['an event name it does not know', { ...event, event: 'made.up' }],
    ['a timestamp that is not a date', { ...event, timestamp: 'yesterday' }],
    ['a date with no time', { ...event, timestamp: '2026-11-03' }],
    ['data that is not an object', { ...event, data: [1, 2] }]
  ])('refuses for good a payload with %s, and writes nothing', async (_label, data) => {
    await expect(processor.process(job(JobNames.TRACK_EVENT, data))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses for good a job the queue does not know', async () => {
    await expect(processor.process(job('mystery', event))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('hands over the event key of a track-event job, so that a redelivery writes nothing twice', async () => {
    await processor.process(job(JobNames.TRACK_EVENT, { ...event, eventKey: 'msg_2abc' }))
    expect(write).toHaveBeenCalledWith({ ...event, eventKey: 'msg_2abc' })
  })

  it('refuses for good an empty event key', async () => {
    await expect(
      processor.process(job(JobNames.TRACK_EVENT, { ...event, eventKey: '' }))
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  describe('rollups', () => {
    const hour: RollupJob = {
      storeId: STORE,
      periodStart: '2026-11-10T09:00:00.000Z',
      periodEnd: '2026-11-10T10:00:00.000Z'
    }
    const day: RollupJob = {
      storeId: STORE,
      periodStart: '2026-11-09T00:00:00.000Z',
      periodEnd: '2026-11-10T00:00:00.000Z'
    }

    it('rolls up the hour of an hourly job for the store of the job', async () => {
      await processor.process(job(JobNames.ROLLUP_HOURLY, hour))
      expect(rollup).toHaveBeenCalledWith('hourly', STORE, {
        start: new Date(hour.periodStart),
        end: new Date(hour.periodEnd)
      })
    })

    it('rolls up the day of a daily job', async () => {
      await processor.process(job(JobNames.ROLLUP_DAILY, day))
      expect(rollup).toHaveBeenCalledWith('daily', STORE, {
        start: new Date(day.periodStart),
        end: new Date(day.periodEnd)
      })
    })

    it.each([
      ['a day under an hourly name', JobNames.ROLLUP_HOURLY, day],
      ['an hour under a daily name', JobNames.ROLLUP_DAILY, hour],
      [
        'an hour that does not start on the hour',
        JobNames.ROLLUP_HOURLY,
        { ...hour, periodStart: '2026-11-10T09:30:00.000Z', periodEnd: '2026-11-10T10:30:00.000Z' }
      ],
      ['a store id that is not a UUID', JobNames.ROLLUP_HOURLY, { ...hour, storeId: 'nope' }],
      ['a period that is not a date', JobNames.ROLLUP_HOURLY, { ...hour, periodStart: 'now' }]
    ])('refuses for good %s, and rolls nothing up', async (_label, name, data) => {
      await expect(processor.process(job(name, data))).rejects.toBeInstanceOf(UnrecoverableError)
      expect(rollup).not.toHaveBeenCalled()
    })

    describe('with the clock at 10:00:00.000', () => {
      beforeEach(() => {
        jest.useFakeTimers({ now: new Date('2026-11-10T10:00:00.000Z') })
      })
      afterEach(() => jest.useRealTimers())

      it('refuses for good the hour that is running, and rolls nothing up', async () => {
        const running = {
          storeId: STORE,
          periodStart: '2026-11-10T10:00:00.000Z',
          periodEnd: '2026-11-10T11:00:00.000Z'
        }
        await expect(
          processor.process(job(JobNames.ROLLUP_HOURLY, running))
        ).rejects.toBeInstanceOf(UnrecoverableError)
        expect(rollup).not.toHaveBeenCalled()
      })

      it('takes the hour that closes at this very moment', async () => {
        await processor.process(job(JobNames.ROLLUP_HOURLY, hour))
        expect(rollup).toHaveBeenCalledTimes(1)
      })
    })

    it('lets a failed rollup fail the job as it is', async () => {
      const failure = new Error('connection lost')
      rollup.mockRejectedValue(failure)
      const error = await processor
        .process(job(JobNames.ROLLUP_HOURLY, hour))
        .catch((e: unknown) => e)
      expect(error).toBe(failure)
      expect(error).not.toBeInstanceOf(UnrecoverableError)
    })
  })

  it('refuses for good a search event that comes as a track-event job: it would skip the check of its data', async () => {
    const search = {
      event: AnalyticsEventNames.SEARCH_PERFORMED,
      storeId: STORE,
      data: { query: 'maria lopez' },
      timestamp: '2026-11-14T09:55:00.000Z'
    }
    await expect(processor.process(job(JobNames.TRACK_EVENT, search))).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(write).not.toHaveBeenCalled()
  })

  describe('the search event', () => {
    const search: TrackAnalyticsJob = {
      event: AnalyticsEventNames.SEARCH_PERFORMED,
      storeId: STORE,
      data: { queryHash: '0123456789abcdef', scope: 'customers', resultCount: 3, durationMs: 12 },
      timestamp: '2026-11-14T09:55:00.000Z'
    }

    it('writes the event of a track-search job', async () => {
      await processor.process(job(JobNames.TRACK_SEARCH, search))
      expect(write).toHaveBeenCalledWith(search)
    })

    it('keeps the text of a product search that found nothing', async () => {
      const none: TrackAnalyticsJob = {
        ...search,
        data: { ...search.data, scope: 'products', resultCount: 0, query: 'zapato rojo' }
      }
      await processor.process(job(JobNames.TRACK_SEARCH, none))
      expect(write).toHaveBeenCalledWith(none)
    })

    it.each([
      ['another event name', { ...search, event: AnalyticsEventNames.ORDER_CREATED }],
      [
        'a hash that is not the one it makes',
        { ...search, data: { ...search.data, queryHash: 'x' } }
      ],
      ['a scope it does not know', { ...search, data: { ...search.data, scope: 'invoices' } }],
      ['a negative count', { ...search, data: { ...search.data, resultCount: -1 } }],
      ['a field it does not carry', { ...search, data: { ...search.data, userId: 'someone' } }],
      [
        'a text longer than the cap',
        { ...search, data: { ...search.data, query: 'a'.repeat(201) } }
      ]
    ])('refuses for good a track-search job with %s, and writes nothing', async (_label, data) => {
      await expect(processor.process(job(JobNames.TRACK_SEARCH, data))).rejects.toBeInstanceOf(
        UnrecoverableError
      )
      expect(write).not.toHaveBeenCalled()
    })
  })
})
