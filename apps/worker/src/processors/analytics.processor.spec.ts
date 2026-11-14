import { type Job, UnrecoverableError } from 'bullmq'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { JobNames, type TrackAnalyticsJob } from '@platform/core/queues'

import type { AnalyticsEventWriter } from '../analytics/analytics-event.writer'

import { AnalyticsProcessor } from './analytics.processor'
import type { ProcessorSupport } from './processor-support'

const STORE = '11111111-1111-4111-8111-111111111111'

describe('AnalyticsProcessor', () => {
  const write = jest.fn<Promise<void>, [TrackAnalyticsJob]>()
  // The inherited support (logs, metrics, dead letter) is not what is under test: it runs the job
  const support = {
    run: (_queue: string, job: Job, run: (job: Job) => Promise<void>) => run(job)
  }
  const processor = new AnalyticsProcessor(
    support as unknown as ProcessorSupport,
    {
      write
    } as unknown as AnalyticsEventWriter
  )
  const job = (name: string, data: unknown): Job<TrackAnalyticsJob> =>
    ({ name, data }) as unknown as Job<TrackAnalyticsJob>
  const event: TrackAnalyticsJob = {
    event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
    storeId: STORE,
    data: { type: 'email.opened', template: 'qa', messageId: 'e1' },
    timestamp: '2026-11-03T09:55:00.000Z'
  }

  beforeEach(() => write.mockReset().mockResolvedValue(undefined))

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

  it('refuses for good a job the queue does not know', async () => {
    await expect(processor.process(job('mystery', event))).rejects.toBeInstanceOf(
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
