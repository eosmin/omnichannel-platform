import { FiscalResourceTypes } from '@platform/core/domain'
import type {
  FiscalDocumentRejectedPayload,
  FiscalDocumentStuckPayload
} from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsEventsListener } from './notifications-events.listener'

const ORG = 'org-1'
const DOCUMENT = 'document-1'

const rejected: FiscalDocumentRejectedPayload = {
  organizationId: ORG,
  storeId: 'store-1',
  documentId: DOCUMENT,
  orderId: 'order-1',
  reason: 'receiver_incomplete'
}
const stuck: FiscalDocumentStuckPayload = {
  organizationId: ORG,
  storeId: 'store-1',
  documentId: DOCUMENT,
  orderId: 'order-1',
  attempts: 6
}

function build(members: { userId: string; storeId: string }[], options: { fails?: boolean } = {}) {
  const asked: unknown[] = []
  const sent: { users: readonly string[]; input: Record<string, unknown> }[] = []
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
    { inc: () => undefined } as never
  )
  return { listener, asked, sent }
}

describe('the notice of a fiscal document that needs a person', () => {
  it('tells whoever manages the fiscal documents of the organization, once each, in the first store they can', async () => {
    const { listener, sent, asked } = build([
      { userId: 'u1', storeId: 's1' },
      { userId: 'u2', storeId: 's1' },
      { userId: 'u1', storeId: 's2' }
    ])
    await listener.onFiscalDocumentRejected(rejected)
    expect(sent.map(item => [item.users, item.input.storeId])).toEqual([
      [['u1'], 's1'],
      [['u2'], 's1']
    ])
    expect(sent[0]?.input).toMatchObject({
      type: NotificationTypes.FISCAL_DOCUMENT_REJECTED,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: DOCUMENT,
      params: {}
    })
    // Only people of the organization who hold the permission to manage the fiscal documents are told
    expect(JSON.stringify(asked[0])).toContain(ORG)
    expect(JSON.stringify(asked[0])).toContain('fiscal:manage')
  })

  it('says a document that ran out of attempts with its own type, and names no receiver, no amount and no reason', async () => {
    const { listener, sent } = build([{ userId: 'u1', storeId: 's1' }])
    await listener.onFiscalDocumentStuck(stuck)
    expect(sent[0]?.input).toMatchObject({
      type: NotificationTypes.FISCAL_DOCUMENT_STUCK,
      resourceId: DOCUMENT,
      params: {}
    })
    expect(JSON.stringify(sent)).not.toContain('receiver_incomplete')
  })

  it('says a document that disagrees with its entry with its own type, and names no amount', async () => {
    const { listener, sent } = build([{ userId: 'u1', storeId: 's1' }])
    await listener.onFiscalEntryMismatch({ organizationId: ORG, documentId: DOCUMENT, count: 3 })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.input).toMatchObject({
      type: NotificationTypes.FISCAL_ENTRY_MISMATCH,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: DOCUMENT,
      params: {}
    })
    // The count is the check's, not the notice's: the text says no number
    expect(JSON.stringify(sent)).not.toContain('3')
  })

  it('tells nobody when nobody can act, and never throws to the bus', async () => {
    const empty = build([])
    await empty.listener.onFiscalDocumentRejected(rejected)
    expect(empty.sent).toEqual([])
    const failing = build([], { fails: true })
    await expect(failing.listener.onFiscalDocumentStuck(stuck)).resolves.toBeUndefined()
    expect(failing.sent).toEqual([])
  })
})
