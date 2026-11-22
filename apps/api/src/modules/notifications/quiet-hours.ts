import { isStoreClosed } from '@platform/core/domain'
import { isInQuietRange } from '@platform/core/notifications'

import type { NotificationSettingsView } from './notifications.views'

export interface StoreHours {
  timezone: string
  schedule: unknown
}

// Whether a person is in quiet hours at a moment, from what was read: the rule of `isInQuietHours` with no reads of its own
export function isQuietAt(
  settings: NotificationSettingsView,
  hours: StoreHours | null,
  at: Date
): boolean {
  if (!settings.quietHoursEnabled) return false
  if (settings.quietHoursFollowStore) return isStoreClosed(hours, at)
  return isInQuietRange(
    { start: settings.quietHoursStart, end: settings.quietHoursEnd, timezone: settings.timezone },
    at
  )
}
