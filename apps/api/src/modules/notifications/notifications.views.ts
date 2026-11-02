import type { DigestFrequency } from '@platform/core/domain'
import type {
  NotificationRealtimePayload,
  NotificationSeverityType,
  NotificationType
} from '@platform/core/notifications'

export const NOTIFICATION_COLUMNS = {
  id: true,
  type: true,
  severity: true,
  messageKey: true,
  params: true,
  resourceType: true,
  resourceId: true,
  actionPath: true,
  readAt: true,
  createdAt: true
} as const

export interface NotificationRow {
  id: string
  type: string
  severity: string
  messageKey: string
  params: unknown
  resourceType: string | null
  resourceId: string | null
  actionPath: string | null
  readAt: Date | null
  createdAt: Date
}

export interface NotificationView {
  id: string
  type: NotificationType
  severity: NotificationSeverityType
  messageKey: string
  params: Record<string, string | number>
  resourceType: string | null
  resourceId: string | null
  actionPath: string | null
  readAt: string | null
  createdAt: string
}

// `type` and `severity` are free strings in the column: the service wrote them from the constants, so
// they are narrowed here and not parsed again
export function notificationView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type as NotificationType,
    severity: row.severity as NotificationSeverityType,
    messageKey: row.messageKey,
    params: row.params as Record<string, string | number>,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    actionPath: row.actionPath,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  }
}

export type { NotificationRealtimePayload }

export interface TypePreferenceView {
  type: NotificationType
  severity: NotificationSeverityType
  inApp: boolean
  push: boolean
  email: boolean
  sound: boolean
}

export interface NotificationSettingsView {
  quietHoursEnabled: boolean
  quietHoursStart: number
  quietHoursEnd: number
  quietHoursFollowStore: boolean
  timezone: string
  digestFrequency: DigestFrequency
  crossStoreEnabled: boolean
  crossStoreSupervisorOnly: boolean
}

export interface PreferencesView {
  types: TypePreferenceView[]
  settings: NotificationSettingsView
}
