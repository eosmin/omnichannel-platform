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
  const runBulk = jest.fn().mockResolvedValue(undefined)
  const runVoid = jest.fn().mockResolvedValue('cancelled')
  const runPickup = jest.fn().mockResolvedValue(undefined)
  const evaluatePickups = jest.fn().mockResolvedValue(null)
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
    { reprocess } as never, // the replay of carrier events: what it is handed is what is tested
    { run: runBulk } as never, // the bulk labels: what it is handed is what is tested
    { run: runVoid } as never, // the void of a guide: what it is handed is what is tested
    { run: runPickup } as never, // the pickup sync: what it is handed is what is tested
    { run: evaluatePickups } as never // the pickup evaluation: what it is handed is what is tested
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
    runBulk.mockClear()
    runVoid.mockClear()
    runPickup.mockClear()
    evaluatePickups.mockClear()
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

  describe('the bulk run of labels (TDD_17 §4.6)', () => {
    const STORE_ID = '8d88e80f-cecb-408a-bd99-9da2db20a7da'
    const JOB_ID = '5b0e7c7a-2f3b-4a53-8f0e-6f5d2c1b9a10'
    const bulkJob = (data: unknown, attemptsMade = 0): Promise<void> =>
      processor.process({
        name: JobNames.BULK_LABELS_MERGE,
        data: JSON.parse(JSON.stringify(data)) as unknown,
        attemptsMade,
        opts: { attempts: 2 }
      } as unknown as ProcessorJob)

    it('hands the run to the runner with what the request chose, and keeps nothing else', async () => {
      const pickup = { date: '2026-12-01', from: '09:00', to: '12:00' }
      await bulkJob({
        storeId: STORE_ID,
        jobId: JOB_ID,
        connectionId: '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0',
        locationIds: { departmentId: '2', municipalityId: '21' },
        locationsByConnection: {
          '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0': { departmentId: '2', municipalityId: '21' }
        },
        pickup,
        canOverridePrice: true,
        extra: 'dropped'
      })

      expect(runBulk).toHaveBeenCalledWith(
        {
          storeId: STORE_ID,
          jobId: JOB_ID,
          connectionId: '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0',
          locationIds: { departmentId: '2', municipalityId: '21' },
          locationsByConnection: {
            '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0': { departmentId: '2', municipalityId: '21' }
          },
          pickup,
          canOverridePrice: true
        },
        false
      )
      expect(fetch).not.toHaveBeenCalled()
    })

    it('tells the runner when this is the last attempt, so that it closes the run as failed', async () => {
      await bulkJob({ storeId: STORE_ID, jobId: JOB_ID, canOverridePrice: false }, 1)

      expect(runBulk).toHaveBeenCalledWith(
        { storeId: STORE_ID, jobId: JOB_ID, canOverridePrice: false },
        true
      )
    })

    it.each([
      ['no run', { storeId: STORE_ID, canOverridePrice: false }],
      ['a run that is no id', { storeId: STORE_ID, jobId: 'x', canOverridePrice: false }],
      ['no store', { jobId: JOB_ID, canOverridePrice: false }],
      ['no word on the price', { storeId: STORE_ID, jobId: JOB_ID }],
      [
        'a pickup that ends before it starts',
        {
          storeId: STORE_ID,
          jobId: JOB_ID,
          canOverridePrice: false,
          pickup: { date: '2026-12-01', from: '12:00', to: '09:00' }
        }
      ],
      [
        'a place without its municipality',
        {
          storeId: STORE_ID,
          jobId: JOB_ID,
          canOverridePrice: false,
          locationIds: { departmentId: '2' }
        }
      ]
    ])('refuses for good a job with %s, and runs nothing', async (_name, data) => {
      await expect(bulkJob(data)).rejects.toBeInstanceOf(UnrecoverableError)
      expect(runBulk).not.toHaveBeenCalled()
    })
  })

  describe('the void of a guide (TDD_17 §4.8)', () => {
    const STORE_ID = '8d88e80f-cecb-408a-bd99-9da2db20a7da'
    const SHIPMENT_ID = '5b0e7c7a-2f3b-4a53-8f0e-6f5d2c1b9a10'
    const USER_ID = '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0'
    const voidJob = (data: unknown, attemptsMade = 0): Promise<void> =>
      processor.process({
        name: JobNames.CANCEL_SHIPMENT,
        data: JSON.parse(JSON.stringify(data)) as unknown,
        attemptsMade,
        opts: { attempts: 5 }
      } as unknown as ProcessorJob)

    it('hands the guide to the canceller with who asked, and keeps nothing else', async () => {
      await voidJob({
        storeId: STORE_ID,
        shipmentId: SHIPMENT_ID,
        requestedBy: USER_ID,
        extra: 'dropped'
      })

      expect(runVoid).toHaveBeenCalledWith(
        { storeId: STORE_ID, shipmentId: SHIPMENT_ID, requestedBy: USER_ID },
        false
      )
    })

    it('tells the canceller when this is the last of the five attempts, and takes the system as who asked', async () => {
      await voidJob({ storeId: STORE_ID, shipmentId: SHIPMENT_ID, requestedBy: null }, 4)

      expect(runVoid).toHaveBeenCalledWith(
        { storeId: STORE_ID, shipmentId: SHIPMENT_ID, requestedBy: null },
        true
      )
    })

    it('lets the queue ask again when the canceller says the carrier did not answer', async () => {
      runVoid.mockRejectedValueOnce(new Error('asking again'))

      await expect(
        voidJob({ storeId: STORE_ID, shipmentId: SHIPMENT_ID, requestedBy: null })
      ).rejects.not.toBeInstanceOf(UnrecoverableError)
    })

    it.each([
      ['no shipment', { storeId: STORE_ID, requestedBy: null }],
      ['a shipment that is no id', { storeId: STORE_ID, shipmentId: 'x', requestedBy: null }],
      ['no store', { shipmentId: SHIPMENT_ID, requestedBy: null }],
      ['no word on who asked', { storeId: STORE_ID, shipmentId: SHIPMENT_ID }]
    ])('refuses for good a job with %s, and voids nothing', async (_name, data) => {
      await expect(voidJob(data)).rejects.toBeInstanceOf(UnrecoverableError)
      expect(runVoid).not.toHaveBeenCalled()
    })
  })
  describe('the sync of a pickup', () => {
    const STORE_ID = '0b1f5a63-8d2e-4c4d-9a41-0a1b2c3d4e5f'
    const PICKUP_ID = '7c0e7c7a-2f3b-4a53-8f0e-6f5d2c1b9a11'
    const USER_ID = '0a4bb3b1-3b6c-4a4f-8b53-6dd1b5a5c2f0'
    const pickupJob = (data: unknown, attemptsMade = 0): Promise<void> =>
      processor.process({
        name: JobNames.SYNC_PICKUP,
        data: JSON.parse(JSON.stringify(data)) as unknown,
        attemptsMade,
        opts: { attempts: 5 }
      } as unknown as ProcessorJob)

    it('hands the pickup over with who asked, and keeps nothing else', async () => {
      await pickupJob({ storeId: STORE_ID, pickupId: PICKUP_ID, requestedBy: USER_ID, extra: 'x' })

      expect(runPickup).toHaveBeenCalledWith(
        { storeId: STORE_ID, pickupId: PICKUP_ID, requestedBy: USER_ID },
        false
      )
    })

    it('tells the syncer when this is the last of the five attempts', async () => {
      await pickupJob({ storeId: STORE_ID, pickupId: PICKUP_ID, requestedBy: null }, 4)

      expect(runPickup).toHaveBeenCalledWith(
        { storeId: STORE_ID, pickupId: PICKUP_ID, requestedBy: null },
        true
      )
    })

    it('lets the queue ask again when the carrier did not answer', async () => {
      runPickup.mockRejectedValueOnce(new Error('asking again'))

      await expect(
        pickupJob({ storeId: STORE_ID, pickupId: PICKUP_ID, requestedBy: null })
      ).rejects.not.toBeInstanceOf(UnrecoverableError)
    })

    it.each([
      ['no pickup', { storeId: STORE_ID, requestedBy: null }],
      ['a pickup that is no id', { storeId: STORE_ID, pickupId: 'x', requestedBy: null }],
      ['no store', { pickupId: PICKUP_ID, requestedBy: null }],
      ['no word on who asked', { storeId: STORE_ID, pickupId: PICKUP_ID }]
    ])('refuses for good a job with %s, and asks nothing', async (_name, data) => {
      await expect(pickupJob(data)).rejects.toBeInstanceOf(UnrecoverableError)
      expect(runPickup).not.toHaveBeenCalled()
    })
  })

  describe('the evaluation of the pickups', () => {
    const evaluateJob = (data: unknown): Promise<void> =>
      processor.process({
        name: JobNames.EVALUATE_PICKUPS,
        data: JSON.parse(JSON.stringify(data)) as unknown,
        attemptsMade: 0,
        opts: { attempts: 1 }
      } as unknown as ProcessorJob)

    it('hands the minute to the evaluator and keeps nothing else the job carries', async () => {
      await evaluateJob({ minute: 29_000_000, extra: 'dropped' })

      expect(evaluatePickups).toHaveBeenCalledWith({ minute: 29_000_000 })
    })

    it.each([
      ['no minute', {}],
      ['a minute that is not a number', { minute: 'now' }],
      ['a minute that is not whole', { minute: 1.5 }]
    ])('refuses for good a job with %s, and evaluates nothing', async (_name, data) => {
      await expect(evaluateJob(data)).rejects.toBeInstanceOf(UnrecoverableError)
      expect(evaluatePickups).not.toHaveBeenCalled()
    })
  })
})
