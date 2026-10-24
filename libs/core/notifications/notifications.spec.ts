import { NotificationChannel } from '@platform/core/domain'

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
