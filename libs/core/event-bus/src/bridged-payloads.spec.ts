import { randomUUID } from 'node:crypto'

import {
  AttentionReasons,
  AuthorType,
  BulkLabelJobStatus,
  ChannelIds,
  ConversationStatus,
  ConversationStatusReasons,
  ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { BridgedEvents, ChannelDisconnectedReasons, Events } from '@platform/core/events'

import { bridgedPayload } from './bridged-payloads'

const read = {
  storeId: randomUUID(),
  conversationId: randomUUID(),
  userId: randomUUID(),
  visibility: { hidden: false, assignedTo: null }
}

describe('bridgedPayload', () => {
  const actor = { type: 'user', id: randomUUID() }
  const message = {
    storeId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    authorId: randomUUID(),
    createdAt: '2026-10-27T00:00:00.000Z',
    visibility: { hidden: false, assignedTo: null }
  }
  const status = {
    storeId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    visibility: { hidden: false, assignedTo: null }
  }
  // A whole payload of each bridged event, as the services publish it
  const whole: Record<string, object> = {
    [Events.CONVERSATION_STATUS_CHANGED]: {
      storeId: randomUUID(),
      conversationId: randomUUID(),
      previousStatus: ConversationStatus.OPEN,
      status: ConversationStatus.RESOLVED,
      assignedTo: null,
      changedBy: actor
    },
    [Events.CONVERSATION_ASSIGNED]: {
      storeId: randomUUID(),
      conversationId: randomUUID(),
      assignedTo: randomUUID(),
      previousAssignee: null,
      assignedBy: actor,
      visibility: { hidden: false, assignedTo: null }
    },
    [Events.CONVERSATION_SNOOZE_EXPIRED]: {
      storeId: randomUUID(),
      conversationId: randomUUID(),
      assignedTo: randomUUID()
    },
    [Events.CONVERSATION_REOPENED]: {
      storeId: randomUUID(),
      conversationId: randomUUID(),
      assignedTo: randomUUID(),
      reason: ConversationStatusReasons.AGENT_REPLIED,
      reopenedBy: { type: 'user', id: randomUUID() }
    },
    [Events.CONVERSATION_UNASSIGNED]: {
      storeId: randomUUID(),
      conversationId: randomUUID(),
      unassignedBy: { type: 'system', id: null }
    },
    [Events.CONVERSATION_CREATED]: {
      storeId: randomUUID(),
      conversationId: randomUUID(),
      customerId: randomUUID(),
      channelType: ChannelIds.WHATSAPP,
      firstMessageId: randomUUID(),
      visibility: { hidden: false, assignedTo: null }
    },
    [Events.MESSAGE_RECEIVED]: {
      storeId: randomUUID(),
      conversationId: randomUUID(),
      messageId: randomUUID(),
      customerId: randomUUID(),
      channelType: ChannelIds.WHATSAPP,
      authorType: AuthorType.CUSTOMER,
      receivedAt: '2026-10-27T00:00:00.000Z',
      visibility: { hidden: false, assignedTo: null }
    },
    [Events.CONVERSATION_READ]: read,
    [Events.CONVERSATION_ATTENTION_CHANGED]: {
      storeId: read.storeId,
      conversationId: read.conversationId,
      reason: AttentionReasons.SNOOZE_WOKE,
      visibility: read.visibility
    },
    [Events.MESSAGE_QUEUED]: { ...message, clientMessageId: 'key-1' },
    [Events.MESSAGE_NOTE_ADDED]: message,
    [Events.MESSAGE_SENT]: status,
    [Events.MESSAGE_DELIVERED]: status,
    [Events.MESSAGE_READ]: status,
    [Events.MESSAGE_REACTION]: status,
    [Events.MESSAGE_EDITED]: { ...status, internal: false },
    [Events.MESSAGE_DELETED]: { ...status, internal: true },
    [Events.MEDIA_PROCESSED]: { ...status, internal: false },
    [Events.MEDIA_INFECTED]: { ...status, internal: false },
    [Events.MEDIA_UNSCANNABLE]: { ...status, internal: false },
    [Events.MEDIA_UNAVAILABLE]: { ...status, internal: false },
    [Events.EXPORT_READY]: {
      storeId: randomUUID(),
      exportId: randomUUID(),
      requestedBy: randomUUID(),
      exportType: 'customers'
    },
    [Events.EXPORT_FAILED]: {
      storeId: randomUUID(),
      exportId: randomUUID(),
      requestedBy: randomUUID(),
      exportType: 'media_zip'
    },
    [Events.MESSAGE_FAILED]: { ...status, errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED },
    [Events.CHANNEL_DISCONNECTED]: {
      storeId: randomUUID(),
      channelConnectionId: randomUUID(),
      pluginId: 'whatsapp',
      reason: ChannelDisconnectedReasons.ERROR
    },
    [Events.CHANNEL_TOKEN_EXPIRING]: {
      storeId: randomUUID(),
      channelConnectionId: randomUUID(),
      pluginId: 'messenger',
      expiresAt: '2026-11-14T10:00:00.000Z'
    },
    [Events.CHANNEL_HEALTH_RESTORED]: {
      storeId: randomUUID(),
      channelConnectionId: randomUUID(),
      pluginId: 'whatsapp'
    },
    [Events.SHIPMENT_STATUS_CHANGED]: {
      storeId: randomUUID(),
      shipmentId: randomUUID(),
      orderId: randomUUID(),
      orderNumber: 'ORD-1',
      connectionId: randomUUID(),
      actor: { type: 'system', id: null },
      from: ShipmentStatus.PICKED_UP,
      to: ShipmentStatus.DELIVERED,
      replay: true
    },
    [Events.SHIPMENT_REQUIRES_REVIEW]: {
      storeId: randomUUID(),
      shipmentId: randomUUID(),
      orderId: randomUUID(),
      orderNumber: 'ORD-1',
      connectionId: randomUUID(),
      actor: { type: 'system', id: null }
    },
    [Events.SHIPMENT_CANCEL_FAILED]: {
      storeId: randomUUID(),
      shipmentId: randomUUID(),
      orderId: randomUUID(),
      orderNumber: 'ORD-1',
      connectionId: randomUUID(),
      actor: { type: 'system', id: null }
    },
    [Events.PICKUP_MANUAL_REQUIRED]: {
      storeId: randomUUID(),
      pickupId: randomUUID(),
      connectionId: randomUUID(),
      pickupDate: '2026-11-13',
      packageCount: 3,
      reason: 'no_api'
    },
    [Events.PICKUP_CUTOFF_APPROACHING]: {
      storeId: randomUUID(),
      connectionId: randomUUID(),
      pickupDate: '2026-11-13',
      waiting: 4,
      minutesLeft: 30
    },
    [Events.CARRIER_STATUS_UNMAPPED]: {
      storeId: randomUUID(),
      connectionId: randomUUID(),
      providerCode: '16:115'
    },
    [Events.REMITTANCE_OVERDUE]: {
      storeId: randomUUID(),
      connectionId: randomUUID(),
      count: 4,
      overdueAfterDays: 7,
      oldestAgeDays: 12,
      totalOwedCents: 45_000
    },
    [Events.BULK_LABELS_PROGRESS]: {
      storeId: randomUUID(),
      jobId: randomUUID(),
      requestedBy: randomUUID(),
      done: 3,
      total: 10,
      failed: 1
    },
    [Events.BULK_LABELS_DONE]: {
      storeId: randomUUID(),
      jobId: randomUUID(),
      requestedBy: randomUUID(),
      status: BulkLabelJobStatus.COMPLETED_WITH_ERRORS,
      mergedMediaId: randomUUID()
    }
  }

  it('has a schema for every bridged event, which passes a whole payload as it is', () => {
    expect(Object.keys(whole).sort()).toEqual([...BridgedEvents].sort())
    for (const event of BridgedEvents) {
      expect(bridgedPayload(event, whole[event])).toEqual(whole[event])
    }
  })

  it('drops a payload whose date is not a date', () => {
    for (const event of [Events.MESSAGE_QUEUED, Events.MESSAGE_NOTE_ADDED]) {
      const payload = { ...(whole[event] as Record<string, unknown>), createdAt: 'last tuesday' }
      expect(bridgedPayload(event, payload)).toBeNull()
    }
  })

  // Fields that may be left out: a move that is a replay says so, and every other move says nothing
  const OPTIONAL_FIELDS: ReadonlySet<string> = new Set(['replay'])

  it('drops a payload of a bridged event with any one of its fields missing', () => {
    for (const event of BridgedEvents) {
      const fields = Object.keys(whole[event] as Record<string, unknown>)
      for (const field of fields.filter(name => !OPTIONAL_FIELDS.has(name))) {
        const incomplete = { ...(whole[event] as Record<string, unknown>) }
        delete incomplete[field]
        expect([event, field, bridgedPayload(event, incomplete)]).toEqual([event, field, null])
      }
    }
  })

  it('passes a shipment move with no replay flag, and refuses one whose flag is not a boolean', () => {
    const move = whole[Events.SHIPMENT_STATUS_CHANGED] as Record<string, unknown>
    const plain = Object.fromEntries(Object.entries(move).filter(([key]) => key !== 'replay'))
    expect(bridgedPayload(Events.SHIPMENT_STATUS_CHANGED, plain)).toEqual(plain)
    expect(bridgedPayload(Events.SHIPMENT_STATUS_CHANGED, { ...plain, replay: 'yes' })).toBeNull()
  })

  it('keeps the fields of each event and drops any other', () => {
    for (const event of BridgedEvents) {
      const withText = { ...(whole[event] as Record<string, unknown>), contentPreview: 'text' }
      expect(bridgedPayload(event, withText)).toEqual(whole[event])
    }
  })

  it('drops a payload whose values are of the wrong kind, nested ones included', () => {
    const status = whole[Events.CONVERSATION_STATUS_CHANGED] as Record<string, unknown>
    const queued = whole[Events.MESSAGE_QUEUED] as Record<string, unknown>
    expect(
      bridgedPayload(Events.CONVERSATION_STATUS_CHANGED, {
        ...status,
        changedBy: { type: 'ai', id: null }
      })
    ).toBeNull()
    expect(
      bridgedPayload(Events.MESSAGE_QUEUED, {
        ...queued,
        visibility: { hidden: 'no', assignedTo: null }
      })
    ).toBeNull()
    expect(bridgedPayload(Events.MESSAGE_QUEUED, { ...queued, createdAt: 42 })).toBeNull()
  })

  it('drops a field that is not in the schema even inside a nested object', () => {
    const queued = whole[Events.MESSAGE_QUEUED] as Record<string, unknown>
    const kept = bridgedPayload(Events.MESSAGE_QUEUED, {
      ...queued,
      visibility: { hidden: false, assignedTo: null, contentPreview: 'text' }
    })

    expect(kept).toEqual(queued)
  })

  it('writes the ids in lower case', () => {
    const upper = { ...read, conversationId: read.conversationId.toUpperCase() }

    expect(bridgedPayload(Events.CONVERSATION_READ, upper)).toEqual(read)
  })

  it('drops a payload that does not fit', () => {
    expect(bridgedPayload(Events.CONVERSATION_READ, { ...read, userId: 'not-a-uuid' })).toBeNull()
    expect(bridgedPayload(Events.CONVERSATION_READ, 'text')).toBeNull()
  })

  it('knows no event that is not bridged, nor a property that every object has', () => {
    expect(bridgedPayload(Events.ORDER_CREATED, read)).toBeNull()
    expect(bridgedPayload('constructor', read)).toBeNull()
    expect(bridgedPayload('toString', read)).toBeNull()
    expect(bridgedPayload('__proto__', read)).toBeNull()
  })

  it('drops a reply whose client key is not the shape a client may send', () => {
    const queued = whole[Events.MESSAGE_QUEUED] as Record<string, unknown>
    for (const clientMessageId of ['has space', 'a'.repeat(129), '']) {
      expect(bridgedPayload(Events.MESSAGE_QUEUED, { ...queued, clientMessageId })).toBeNull()
    }
    expect(bridgedPayload(Events.MESSAGE_QUEUED, { ...queued, clientMessageId: null })).toEqual({
      ...queued,
      clientMessageId: null
    })
  })
})
