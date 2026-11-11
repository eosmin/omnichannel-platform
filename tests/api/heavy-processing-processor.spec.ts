import { UnrecoverableError } from 'bullmq'

import { ChannelIds } from '@platform/core/domain'
import { JobNames } from '@platform/core/queues'

import { HeavyProcessingProcessor } from '../../apps/worker/src/processors/heavy-processing.processor'
import type { ProcessorSupport } from '../../apps/worker/src/processors/processor-support'

type ProcessorJob = Parameters<HeavyProcessingProcessor['process']>[0]

describe('HeavyProcessingProcessor', () => {
  const fetch = jest.fn().mockResolvedValue(undefined)
  const reconcileStore = jest.fn().mockResolvedValue(undefined)
  const poll = jest.fn().mockResolvedValue(undefined)
  const clean = { read: 1, applied: 1, stored: 0, left: 0, unconfirmed: 0, failed: 0 }
  const reprocess = jest.fn().mockResolvedValue(clean)
  const support = {
    run: (_queue: string, current: ProcessorJob, work: (job: ProcessorJob) => Promise<void>) =>
      work(current)
  } as unknown as ProcessorSupport // test double: runs the work with no metrics
  const processor = new HeavyProcessingProcessor(
    support,
    {} as never, // the pipeline is not what is tested
    { fetch } as never, // the inbound fetcher: what it is handed is what is tested
    {} as never, // the origin fetcher is not what is tested
    { reconcileStore } as never, // the reconciler of the stock: what it is handed is what is tested
    { poll } as never, // the poller of the carriers: what it is handed is what is tested
    { reprocess } as never // the replay of carrier events: what it is handed is what is tested
  )

  const base = {
    messageId: '2d307c85-af40-4e6f-9c63-2c3d4e5f6071',
    index: 0,
    storeId: '0b1f5a63-8d2e-4c4d-9a41-0a1b2c3d4e5f',
    pluginId: ChannelIds.WEB_WIDGET,
    connectionId: 'conn',
    mediaRef: 'ref',
    contentType: 'image/jpeg',
    filename: 'a.jpg'
  }
  // What the queue stores is JSON: the worker reads the job that crossed Redis
  const run = (data: unknown): Promise<void> =>
    processor.process({
      name: JobNames.FETCH_INBOUND_MEDIA,
      data: JSON.parse(JSON.stringify(data)) as unknown,
      attemptsMade: 0,
      opts: { attempts: 5 }
    } as unknown as ProcessorJob)

  beforeEach(() => {
    fetch.mockClear()
    reconcileStore.mockClear()
    poll.mockClear()
    reprocess.mockClear()
  })

  it('hands the inbound media job to the fetcher with the id the widget chose for the file', async () => {
    const data = {
      ...base,
      mediaId: '4f529ea7-c162-4081-9e85-4e5f60718293',
      correlationId: 'req-1'
    }

    await run(data)

    expect(fetch).toHaveBeenCalledWith(data, false)
  })

  it('hands over a job with no chosen id as it came, with no key invented', async () => {
    await run(base)

    const [handed] = fetch.mock.calls[0] as [Record<string, unknown>]
    expect(Object.keys(handed).sort()).toEqual(Object.keys(base).sort())
  })

  it.each([
    ['a negative place', { ...base, index: -1 }],
    ['a message that is no id', { ...base, messageId: 'x' }]
  ])('refuses for good a job with %s', async (_name, data) => {
    await expect(run(data)).rejects.toBeInstanceOf(UnrecoverableError)
    expect(fetch).not.toHaveBeenCalled()
  })

  describe('the replay of carrier events', () => {
    const data = {
      storeId: '8d88e80f-cecb-408a-bd99-9da2db20a7da',
      connectionId: '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0',
      providerCode: '16:115'
    }
    const replay = (payload: unknown): Promise<void> =>
      processor.process({
        name: JobNames.REPROCESS_CARRIER_EVENTS,
        data: JSON.parse(JSON.stringify(payload)) as unknown,
        attemptsMade: 0,
        opts: { attempts: 3 }
      } as unknown as ProcessorJob)

    it('hands the code of the connection to the replay, and keeps nothing else the job carries', async () => {
      await replay({ ...data, extra: 'dropped', correlationId: 'c' })

      expect(reprocess).toHaveBeenCalledWith({ ...data, correlationId: 'c' })
    })

    it.each([
      ['failed', { ...clean, failed: 1 }],
      ['unconfirmed', { ...clean, unconfirmed: 2 }]
    ])('asks again when lines %s, so they are not kept for good', async (_name, report) => {
      reprocess.mockResolvedValueOnce(report)

      const attempt = replay(data)

      await expect(attempt).rejects.toThrow('could not be replayed yet')
      await expect(attempt).rejects.not.toBeInstanceOf(UnrecoverableError)
    })

    it.each([
      ['a store that is not an id', { ...data, storeId: 'all' }],
      ['a connection that is not an id', { ...data, connectionId: 'x' }],
      ['no code', { storeId: data.storeId, connectionId: data.connectionId }],
      ['an empty code', { ...data, providerCode: '' }],
      ['a code too long to be one', { ...data, providerCode: 'x'.repeat(500) }]
    ])('refuses for good a job with %s', async (_name, payload) => {
      await expect(replay(payload)).rejects.toBeInstanceOf(UnrecoverableError)
      expect(reprocess).not.toHaveBeenCalled()
    })
  })

  describe('the reconciliation of the stock', () => {
    const STORE_ID = '8d88e80f-cecb-408a-bd99-9da2db20a7da'
    const reconcile = (data: unknown): Promise<void> =>
      processor.process({
        name: JobNames.RECONCILE_INVENTORY,
        data: JSON.parse(JSON.stringify(data)) as unknown,
        attemptsMade: 0,
        opts: { attempts: 3 }
      } as unknown as ProcessorJob)

    it('reconciles the store the job names, and fetches nothing', async () => {
      await reconcile({ storeId: STORE_ID, correlationId: 'c' })

      expect(reconcileStore).toHaveBeenCalledWith(STORE_ID)
      expect(fetch).not.toHaveBeenCalled()
    })

    it.each([
      ['no store', {}],
      ['a store that is not an id', { storeId: 'all' }],
      ['a store that is not text', { storeId: 7 }]
    ])('refuses for good a job with %s, and reconciles nothing', async (_name, data) => {
      await expect(reconcile(data)).rejects.toBeInstanceOf(UnrecoverableError)
      expect(reconcileStore).not.toHaveBeenCalled()
    })
  })
  describe('the poll of a carrier (TDD_17 §4.9)', () => {
    const STORE_ID = '8d88e80f-cecb-408a-bd99-9da2db20a7da'
    const CONNECTION_ID = '5b0e7c7a-2f3b-4a53-8f0e-6f5d2c1b9a10'
    const pollJob = (data: unknown): Promise<void> =>
      processor.process({
        name: JobNames.POLL_SHIPMENT_STATUS,
        data: JSON.parse(JSON.stringify(data)) as unknown,
        attemptsMade: 0,
        opts: { attempts: 3 }
      } as unknown as ProcessorJob)

    it('asks the connection the job names, and asks for the old packages only when it says so', async () => {
      await pollJob({ storeId: STORE_ID, connectionId: CONNECTION_ID, includeOld: true })

      expect(poll).toHaveBeenCalledWith(STORE_ID, CONNECTION_ID, { includeOld: true })
      expect(fetch).not.toHaveBeenCalled()
    })

    it.each([
      ['no connection', { storeId: STORE_ID, includeOld: false }],
      ['a connection that is no id', { storeId: STORE_ID, connectionId: 'x', includeOld: false }],
      ['no store', { connectionId: CONNECTION_ID, includeOld: false }],
      ['no word on the old packages', { storeId: STORE_ID, connectionId: CONNECTION_ID }]
    ])('refuses for good a job with %s, and polls nothing', async (_name, data) => {
      await expect(pollJob(data)).rejects.toBeInstanceOf(UnrecoverableError)
      expect(poll).not.toHaveBeenCalled()
    })
  })
})
