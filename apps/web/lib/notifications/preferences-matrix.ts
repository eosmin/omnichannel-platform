import type { TypePreferenceView } from '@platform/api-client'
import {
  NotificationGroups,
  NotificationGroupTypes,
  type NotificationGroup
} from '@platform/core/notifications'

export const PreferenceChannels = {
  IN_APP: 'inApp',
  PUSH: 'push',
  EMAIL: 'email',
  SOUND: 'sound'
} as const
export type PreferenceChannel = (typeof PreferenceChannels)[keyof typeof PreferenceChannels]

export const PREFERENCE_CHANNEL_ORDER: readonly PreferenceChannel[] = [
  PreferenceChannels.IN_APP,
  PreferenceChannels.PUSH,
  PreferenceChannels.EMAIL,
  PreferenceChannels.SOUND
]

export interface PreferenceGroup {
  group: NotificationGroup
  rows: TypePreferenceView[]
}

// The rows of the matrix in the order of TDD_06 §9. A type the server sends that no group lists (the
// org-level ones, or one this page does not know yet) is left out, as the TDD says.
export function groupPreferences(types: readonly TypePreferenceView[]): PreferenceGroup[] {
  const byType = new Map(types.map(row => [row.type, row]))
  return Object.values(NotificationGroups)
    .map(group => ({
      group,
      rows: NotificationGroupTypes[group].flatMap(type => {
        const row = byType.get(type)
        return row === undefined ? [] : [row]
      })
    }))
    .filter(entry => entry.rows.length > 0)
}

// "07:00" for the hour of a select
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

// The zones the browser knows, with the person's own first when this runtime does not list it
export function timeZoneOptions(current: string, supported: readonly string[]): string[] {
  return supported.includes(current) ? [...supported] : [current, ...supported]
}
