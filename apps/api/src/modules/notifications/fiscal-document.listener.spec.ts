import { FiscalContingencyAlertKind, FiscalResourceTypes } from '@platform/core/domain'
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

function build(
  members: { userId: string; storeId: string }[],
  options: { fails?: boolean; documentStore?: string | null } = {}
) {
  const asked: unknown[] = []
  const sent: { users: readonly string[]; input: Record<string, unknown> }[] = []
  const documentStore = options.documentStore === undefined ? 's1' : options.documentStore
  const prisma = {
    client: {
      fiscalDocument: {
        findFirst: () => Promise.resolve(documentStore === null ? null : { storeId: documentStore })
      },
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
    { inc: () => undefined } as never,
    {
      inStore: (_id: string, work: () => Promise<unknown>) => work(),
      inOrganization: (_id: string, work: () => Promise<unknown>) => work()
    } as never
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
    // A document is told only to the managers of the store of its sale (HC-128), never to those of another store
    expect(JSON.stringify(asked[0])).toContain('"storeId":"s1"')
  })

  it("tells no one of a document that is not the organization's, and asks no member", async () => {
    const { listener, sent, asked } = build([{ userId: 'u1', storeId: 's1' }], {
      documentStore: null
    })
    await listener.onFiscalEntryMismatch({ organizationId: ORG, documentId: DOCUMENT, count: 1 })
    expect(sent).toEqual([])
    expect(asked).toEqual([])
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

  it('says a refused document whose window to be sent again is closing with its own type, to the managers of its store', async () => {
    const { listener, sent, asked } = build([{ userId: 'u1', storeId: 's1' }])
    await listener.onFiscalRetransmitDeadline({
      organizationId: ORG,
      storeId: 's1',
      documentId: DOCUMENT,
      orderId: 'order-1',
      expired: true
    })
    expect(sent[0]?.input).toMatchObject({
      type: NotificationTypes.FISCAL_RETRANSMIT_DEADLINE,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: DOCUMENT,
      params: {}
    })
    expect(JSON.stringify(asked[0])).toContain('fiscal:manage')
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

  it('says each alert of a contingency with its own type, about the contingency and not a document', async () => {
    const expected = [
      [FiscalContingencyAlertKind.OPENED_BY_SYSTEM, NotificationTypes.FISCAL_CONTINGENCY_OPENED],
      [
        FiscalContingencyAlertKind.REPORT_FAILED,
        NotificationTypes.FISCAL_CONTINGENCY_REPORT_FAILED
      ],
      [
        FiscalContingencyAlertKind.WINDOW_CLOSING,
        NotificationTypes.FISCAL_CONTINGENCY_WINDOW_CLOSING
      ],
      [
        FiscalContingencyAlertKind.CLOSED_BY_SYSTEM,
        NotificationTypes.FISCAL_CONTINGENCY_CLOSED_BY_SYSTEM
      ],
      [FiscalContingencyAlertKind.RESTORED, NotificationTypes.FISCAL_CONTINGENCY_RESTORED],
      [
        FiscalContingencyAlertKind.TECHNICAL_REPORT_REQUIRED,
        NotificationTypes.FISCAL_CONTINGENCY_TECHNICAL_REPORT
      ]
    ] as const
    for (const [kind, type] of expected) {
      const { listener, sent, asked } = build([{ userId: 'u1', storeId: 's1' }])
      await listener.onFiscalContingencyAlert({
        organizationId: ORG,
        contingencyId: 'contingency-1',
        kind
      })
      expect(sent[0]?.input).toMatchObject({
        type,
        resourceType: FiscalResourceTypes.CONTINGENCY,
        resourceId: 'contingency-1',
        params: {}
      })
      expect(JSON.stringify(asked[0])).toContain('fiscal:manage')
    }
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
