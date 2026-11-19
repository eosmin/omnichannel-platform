import {
  FinanceEventKind,
  FinancePostingFailureReason,
  FinanceSourceType
} from '@platform/core/domain'
import type { FinancePostingFailedPayload } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsEventsListener } from './notifications-events.listener'

const ORG = 'org-1'
const SOURCE = 'source-1'

const payload: FinancePostingFailedPayload = {
  organizationId: ORG,
  sourceType: FinanceSourceType.ORDER,
  sourceId: SOURCE,
  eventKind: FinanceEventKind.SALE,
  reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
  attempts: 1
}

function build(members: { userId: string; storeId: string }[], options: { fails?: boolean } = {}) {
  const asked: unknown[] = []
  const sent: { users: readonly string[]; input: Record<string, unknown> }[] = []
  const counted: unknown[] = []
  const prisma = {
    client: {
      membership: {
        findMany: (args: unknown) => {
          asked.push(args)
          return options.fails === true
            ? Promise.reject(new Error('down'))
            : Promise.resolve(members)
        }
      }
    }
  }
  const notifications = {
    sendToUsersOnce: (users: readonly string[], input: Record<string, unknown>) => {
      sent.push({ users, input })
      return Promise.resolve()
    }
  }
  const listener = new NotificationsEventsListener(
    prisma as never,
    notifications as never,
    {} as never,
    { inc: (labels: unknown) => counted.push(labels) } as never,
    { inStore: (_id: string, work: () => Promise<unknown>) => work() } as never
  )
  return { listener, asked, sent, counted }
}

describe('the notice of a failed posting of the books', () => {
  it('counts the failure by its reason and tells whoever can fix it, once each, in the first store they can', async () => {
    const { listener, sent, counted, asked } = build([
      { userId: 'u1', storeId: 's1' },
      { userId: 'u2', storeId: 's1' },
      { userId: 'u1', storeId: 's2' }
    ])
    await listener.onFinancePostingFailed(payload)
    expect(counted).toEqual([{ reason: FinancePostingFailureReason.ROLE_NOT_MAPPED }])
    expect(sent.map(item => [item.users, item.input.storeId])).toEqual([
      [['u1'], 's1'],
      [['u2'], 's1']
    ])
    expect(sent[0]?.input).toMatchObject({
      type: NotificationTypes.FINANCE_POSTING_FAILED,
      resourceId: `${FinanceEventKind.SALE}:${SOURCE}`,
      params: {}
    })
    // Only people of the organization who hold the permission of "post again" are asked for
    expect(JSON.stringify(asked[0])).toContain(ORG)
    expect(JSON.stringify(asked[0])).toContain('finance:manage_accounts')
  })

  it('tells nobody when nobody can fix it, and never throws to the bus', async () => {
    const empty = build([])
    await empty.listener.onFinancePostingFailed(payload)
    expect(empty.sent).toEqual([])
    const broken = build([], { fails: true })
    await expect(broken.listener.onFinancePostingFailed(payload)).resolves.toBeUndefined()
    // The failure is counted even when the notice could not be sent
    expect(broken.counted).toHaveLength(1)
  })
})
