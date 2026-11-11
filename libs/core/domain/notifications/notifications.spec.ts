import { NotificationChannel } from '../index'

import {
  isDailyDigestHour,
  NotificationDefaults,
  NotificationGroupTypes,
  NotificationSeverity,
  NotificationTypes,
  NotificationTypesWithoutEmitter,
  notificationMessageKey
} from './notification-constants'

describe('NotificationDefaults', () => {
  it('has exactly one entry per notification type', () => {
    expect(Object.keys(NotificationDefaults).sort()).toEqual(
      Object.values(NotificationTypes).sort()
    )
  })

  it('always delivers in the app and lists each channel once', () => {
    for (const { channels } of Object.values(NotificationDefaults)) {
      expect(channels).toContain(NotificationChannel.IN_APP)
      expect(new Set(channels).size).toBe(channels.length)
    }
  })

  it('uses a known severity', () => {
    const severities = Object.values(NotificationSeverity)
    for (const { severity } of Object.values(NotificationDefaults)) {
      expect(severities).toContain(severity)
    }
  })

  it('has no billing, AI, SLA or impersonation types', () => {
    const forbidden = /(quota|ai_|sla|impersonation|referral)/
    expect(Object.values(NotificationTypes).filter(t => forbidden.test(t))).toEqual([])
  })
})

describe('NotificationGroupTypes', () => {
  it('lists every type once, except the org-level data-request ones', () => {
    const listed = Object.values(NotificationGroupTypes).flat()
    expect(new Set(listed).size).toBe(listed.length)
    const missing = Object.values(NotificationTypes).filter(type => !listed.includes(type))
    expect(missing.sort()).toEqual(
      [NotificationTypes.DSR_DEADLINE_APPROACHING, NotificationTypes.DSR_MANUAL_REVIEW].sort()
    )
  })
})

describe('notificationMessageKey', () => {
  it('derives the i18n key from the type', () => {
    expect(notificationMessageKey(NotificationTypes.CONVERSATION_ASSIGNED)).toBe(
      'notifications.conversation.assigned'
    )
  })
})

describe('channel rule', () => {
  it('reaches people away from the app when money or a legal deadline is involved', () => {
    const mustReachByEmail = [
      NotificationTypes.CHANNEL_DISCONNECTED,
      NotificationTypes.WEBHOOK_AUTO_DISABLED,
      NotificationTypes.DSR_DEADLINE_APPROACHING,
      NotificationTypes.SHIPMENT_CANCEL_FAILED,
      NotificationTypes.SHIPMENT_REQUIRES_REVIEW,
      NotificationTypes.REMITTANCE_OVERDUE,
      NotificationTypes.CARRIER_STATUS_UNMAPPED
    ]
    for (const type of mustReachByEmail) {
      expect(NotificationDefaults[type].channels).toContain(NotificationChannel.EMAIL)
    }
  })

  it('pushes what is time-sensitive or leaves a customer uninformed', () => {
    const mustPush = [
      NotificationTypes.PICKUP_CUTOFF_APPROACHING,
      NotificationTypes.PICKUP_MANUAL_REQUIRED,
      NotificationTypes.ORDER_MESSAGE_NOT_SENT,
      NotificationTypes.ORDER_PRICE_APPROVAL_REQUESTED
    ]
    for (const type of mustPush) {
      expect(NotificationDefaults[type].channels).toContain(NotificationChannel.PUSH)
    }
  })

  it('pushes a customer message to its owner and the unassigned queue to who can take it', () => {
    for (const type of [
      NotificationTypes.MESSAGE_RECEIVED,
      NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE
    ]) {
      expect(NotificationDefaults[type].channels).toContain(NotificationChannel.PUSH)
    }
  })

  it('plays sound only for inbox events', () => {
    for (const [type, { channels }] of Object.entries(NotificationDefaults)) {
      if (channels.includes(NotificationChannel.SOUND)) {
        expect(type).toMatch(/^(conversation|message)\./)
      }
    }
  })
})

describe('isDailyDigestHour', () => {
  // 14:10 UTC is 08:10 in El Salvador (UTC-6, no daylight saving) and 15:10 in Madrid in winter
  const at = new Date('2026-11-02T14:10:00.000Z')

  it('is true only where the local clock reads the digest hour', () => {
    expect(isDailyDigestHour('America/El_Salvador', at)).toBe(true)
    expect(isDailyDigestHour('UTC', at)).toBe(false)
    expect(isDailyDigestHour('Europe/Madrid', at)).toBe(false)
  })
})

describe('NotificationTypesWithoutEmitter', () => {
  it('holds the commerce types, the webhook and the plugin ones, and none the inbox raises', () => {
    for (const type of [
      NotificationTypes.ORDER_CREATED,
      // Declared in Step 4.3 PR A, raised by the orders service of PR B, which then takes it off this list
      NotificationTypes.ORDER_PACKING_NOTE_CHANGED,
      NotificationTypes.COUNT_AWAITING_APPLY,
      NotificationTypes.REMITTANCE_OVERDUE,
      NotificationTypes.WEBHOOK_AUTO_DISABLED,
      NotificationTypes.PLUGIN_ERROR
    ]) {
      expect(NotificationTypesWithoutEmitter.has(type)).toBe(true)
    }
    for (const type of [
      NotificationTypes.CONVERSATION_ASSIGNED,
      NotificationTypes.MESSAGE_FAILED,
      NotificationTypes.MEMBER_JOINED,
      NotificationTypes.CHANNEL_DISCONNECTED,
      NotificationTypes.EXPORT_READY,
      NotificationTypes.INVENTORY_LOW,
      // Raised by the transfers service since Step 4.5
      NotificationTypes.TRANSFER_DISPATCHED
    ]) {
      expect(NotificationTypesWithoutEmitter.has(type)).toBe(false)
    }
  })

  it('only names types that exist', () => {
    const all = new Set<string>(Object.values(NotificationTypes))
    for (const type of NotificationTypesWithoutEmitter) expect(all.has(type)).toBe(true)
  })
})

describe('the packing note notice', () => {
  it('is an order notification that warns, and reaches people away from the app', () => {
    expect(NotificationDefaults[NotificationTypes.ORDER_PACKING_NOTE_CHANGED]).toEqual({
      severity: NotificationSeverity.WARNING,
      channels: [NotificationChannel.IN_APP, NotificationChannel.PUSH]
    })
    expect(NotificationGroupTypes.orders).toContain(NotificationTypes.ORDER_PACKING_NOTE_CHANGED)
    expect(notificationMessageKey(NotificationTypes.ORDER_PACKING_NOTE_CHANGED)).toBe(
      'notifications.order.packing_note_changed'
    )
  })
})
