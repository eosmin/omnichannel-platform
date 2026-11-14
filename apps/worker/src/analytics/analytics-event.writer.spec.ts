import { AnalyticsEventNames } from '@platform/core/analytics'
import type { PrismaService } from '@platform/core/database'

import { AnalyticsEventWriter } from './analytics-event.writer'

const STORE = '11111111-1111-4111-8111-111111111111'

describe('AnalyticsEventWriter', () => {
  const createMany = jest.fn<
    Promise<{ count: number }>,
    [{ data: Record<string, unknown>[]; skipDuplicates: boolean }]
  >()
  const writer = new AnalyticsEventWriter({
    client: { analyticsEvent: { createMany } }
  } as unknown as PrismaService)

  beforeEach(() => createMany.mockReset().mockResolvedValue({ count: 1 }))

  it('stores the event under its store, with the UTC day of its timestamp', async () => {
    const written = await writer.write({
      event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
      storeId: STORE,
      data: { type: 'email.opened' },
      timestamp: '2026-11-03T23:59:30.000Z'
    })
    expect(written).toBe(true)
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          storeId: STORE,
          event: 'email.engagement',
          data: { type: 'email.opened' },
          date: new Date('2026-11-03T00:00:00.000Z'),
          timestamp: new Date('2026-11-03T23:59:30.000Z'),
          eventKey: null
        }
      ],
      skipDuplicates: true
    })
  })

  it('puts an event just after midnight UTC on the day that begins', async () => {
    await writer.write({
      event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
      storeId: STORE,
      data: {},
      timestamp: '2026-11-04T00:00:01.000Z'
    })
    expect(createMany.mock.calls[0]?.[0].data[0]?.['date']).toEqual(
      new Date('2026-11-04T00:00:00.000Z')
    )
  })

  it('lets a failed insert fail the job', async () => {
    createMany.mockRejectedValue(new Error('connection lost'))
    await expect(
      writer.write({
        event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
        storeId: STORE,
        data: {},
        timestamp: '2026-11-04T00:00:01.000Z'
      })
    ).rejects.toThrow('connection lost')
  })

  it('hands the key of the event to the unique index and skips a duplicate', async () => {
    await writer.write({
      event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
      storeId: STORE,
      data: {},
      timestamp: '2026-11-04T00:00:01.000Z',
      eventKey: 'msg_1'
    })
    const call = createMany.mock.calls[0]?.[0]
    expect(call?.data[0]?.['eventKey']).toBe('msg_1')
    expect(call?.skipDuplicates).toBe(true)
  })

  it('says whether it wrote a row: a duplicate writes none', async () => {
    createMany.mockResolvedValue({ count: 0 })
    await expect(
      writer.write({
        event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
        storeId: STORE,
        data: {},
        timestamp: '2026-11-04T00:00:01.000Z',
        eventKey: 'msg_1'
      })
    ).resolves.toBe(false)
  })
})
