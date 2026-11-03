import { AnalyticsEventNames } from '@platform/core/analytics'
import type { PrismaService } from '@platform/core/database'

import { AnalyticsEventWriter } from './analytics-event.writer'

const STORE = '11111111-1111-4111-8111-111111111111'

describe('AnalyticsEventWriter', () => {
  const create = jest.fn<Promise<unknown>, [{ data: Record<string, unknown> }]>()
  const writer = new AnalyticsEventWriter({
    client: { analyticsEvent: { create } }
  } as unknown as PrismaService)

  beforeEach(() => create.mockReset().mockResolvedValue({}))

  it('stores the event under its store, with the UTC day of its timestamp', async () => {
    await writer.write({
      event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
      storeId: STORE,
      data: { type: 'email.opened' },
      timestamp: '2026-11-03T23:59:30.000Z'
    })
    expect(create).toHaveBeenCalledWith({
      data: {
        storeId: STORE,
        event: 'email.engagement',
        data: { type: 'email.opened' },
        date: new Date('2026-11-03T00:00:00.000Z'),
        timestamp: new Date('2026-11-03T23:59:30.000Z')
      }
    })
  })

  it('puts an event just after midnight UTC on the day that begins', async () => {
    await writer.write({
      event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
      storeId: STORE,
      data: {},
      timestamp: '2026-11-04T00:00:01.000Z'
    })
    expect(create.mock.calls[0]?.[0].data['date']).toEqual(new Date('2026-11-04T00:00:00.000Z'))
  })

  it('lets a failed insert fail the job', async () => {
    create.mockRejectedValue(new Error('connection lost'))
    await expect(
      writer.write({
        event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
        storeId: STORE,
        data: {},
        timestamp: '2026-11-04T00:00:01.000Z'
      })
    ).rejects.toThrow('connection lost')
  })
})
