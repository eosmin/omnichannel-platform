import { UnrecoverableError } from 'bullmq'

import { ChannelIds } from '@platform/core/domain'
import { JobNames } from '@platform/core/queues'

import { HeavyProcessingProcessor } from '../../apps/worker/src/processors/heavy-processing.processor'
import type { ProcessorSupport } from '../../apps/worker/src/processors/processor-support'

type ProcessorJob = Parameters<HeavyProcessingProcessor['process']>[0]

describe('HeavyProcessingProcessor', () => {
  const fetch = jest.fn().mockResolvedValue(undefined)
  const reconcileStore = jest.fn().mockResolvedValue(undefined)
  const support = {
    run: (_queue: string, current: ProcessorJob, work: (job: ProcessorJob) => Promise<void>) =>
      work(current)
  } as unknown as ProcessorSupport // test double: runs the work with no metrics
  const processor = new HeavyProcessingProcessor(
    support,
    {} as never, // the pipeline is not what is tested
    { fetch } as never, // the inbound fetcher: what it is handed is what is tested
    {} as never, // the origin fetcher is not what is tested
    { reconcileStore } as never // the reconciler of the stock: what it is handed is what is tested
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
})
