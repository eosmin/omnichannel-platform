import { Permissions } from '@platform/core/auth'
import type { DsrAttentionPayload, DsrDeadlinePayload } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsEventsListener } from './notifications-events.listener'

const STORE = 'store-1'
const REQUEST = 'request-1'

function build(options: { found?: boolean; fails?: boolean } = {}) {
  const asked: unknown[] = []
  const sent: Record<string, unknown>[] = []
  const prisma = {
    client: {
      dataSubjectRequest: {
        findFirst: (args: unknown) => {
          asked.push(args)
          if (options.fails === true) return Promise.reject(new Error('down'))
          return Promise.resolve(options.found === false ? null : { id: REQUEST })
        }
      }
    }
  }
  const notifications = {
    sendToStore: (input: Record<string, unknown>) => {
      sent.push(input)
      return Promise.resolve()
    }
  }
  const listener = new NotificationsEventsListener(
    prisma as never,
    notifications as never,
    {} as never,
    { inc: jest.fn() } as never,
    {
      inStore: (_id: string, work: () => Promise<unknown>) => work(),
      inOrganization: (_id: string, work: () => Promise<unknown>) => work()
    } as never
  )
  return { listener, asked, sent }
}

const attention: DsrAttentionPayload = {
  storeId: STORE,
  requestId: REQUEST,
  type: 'erasure',
  reason: 'attempts_exhausted'
}
const deadline: DsrDeadlinePayload = {
  storeId: STORE,
  requestId: REQUEST,
  type: 'access',
  daysLeft: 4
}

describe('the notices of the data requests that need the reviewers', () => {
  it('tells the people who review data requests, and only them, that a request is close to its deadline', async () => {
    const { listener, sent } = build()

    await listener.onDsrDeadlineApproaching(deadline)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      storeId: STORE,
      type: NotificationTypes.DSR_DEADLINE_APPROACHING,
      params: { days: 4 },
      resourceId: REQUEST,
      requiredPermission: Permissions.CUSTOMERS_DSR_REVIEW
    })
  })

  it('tells them that a request came back to the review queue, and that a person was never told how theirs ended', async () => {
    const { listener, sent } = build()

    await listener.onDsrReturnedToReview(attention)
    await listener.onDsrNoticeFailed({ ...attention, reason: 'mail_failed' })

    expect(sent.map(item => item.type)).toEqual([
      NotificationTypes.DSR_MANUAL_REVIEW,
      NotificationTypes.DSR_NOTICE_FAILED
    ])
    for (const item of sent) expect(item.requiredPermission).toBe(Permissions.CUSTOMERS_DSR_REVIEW)
  })

  it('looks for the request under the store of the event: a request of another store tells nobody', async () => {
    const { listener, sent, asked } = build({ found: false })

    await listener.onDsrNoticeFailed(attention)

    expect(JSON.stringify(asked[0])).toContain(STORE)
    expect(JSON.stringify(asked[0])).toContain(REQUEST)
    expect(sent).toEqual([])
  })

  it('never throws to the bus, and puts no code or address in the text', async () => {
    const broken = build({ fails: true })
    await expect(broken.listener.onDsrReturnedToReview(attention)).resolves.toBeUndefined()
    const { listener, sent } = build()

    await listener.onDsrReturnedToReview({ ...attention, reason: 'subject_changed' })

    expect(JSON.stringify(sent)).not.toContain('subject_changed')
    expect(JSON.stringify(sent)).not.toContain('@')
  })
})
