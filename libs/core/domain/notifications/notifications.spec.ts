import { NotificationChannel } from '../index'

import {
  NotificationDefaults,
  NotificationSeverity,
  NotificationTypes,
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

  it('plays sound only for inbox events', () => {
    for (const [type, { channels }] of Object.entries(NotificationDefaults)) {
      if (channels.includes(NotificationChannel.SOUND)) {
        expect(type).toMatch(/^(conversation|message)\./)
      }
    }
  })
})
