import { NotificationSettingsDefaults } from '@platform/core/notifications'

import { isQuietAt } from './quiet-hours'

const closedAllWeek = {
  timezone: 'UTC',
  schedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }
}
// A Monday, 03:00 UTC
const at = new Date('2026-03-02T03:00:00Z')

describe('isQuietAt', () => {
  it('is never quiet when the person did not turn quiet hours on', () => {
    expect(
      isQuietAt({ ...NotificationSettingsDefaults, quietHoursEnabled: false }, closedAllWeek, at)
    ).toBe(false)
  })

  it('follows the store: quiet while it is closed, never without hours or with hours that cannot be read', () => {
    const follows = {
      ...NotificationSettingsDefaults,
      quietHoursEnabled: true,
      quietHoursFollowStore: true
    }
    expect(isQuietAt(follows, closedAllWeek, at)).toBe(true)
    expect(isQuietAt(follows, null, at)).toBe(false)
    expect(isQuietAt(follows, { timezone: 'UTC', schedule: { mon: 'nine' } }, at)).toBe(false)
  })

  it('reads the own range on the clock of the own timezone, a range that wraps midnight included', () => {
    const own = {
      ...NotificationSettingsDefaults,
      quietHoursEnabled: true,
      quietHoursFollowStore: false,
      quietHoursStart: 22,
      quietHoursEnd: 7,
      timezone: 'UTC'
    }
    expect(isQuietAt(own, null, at)).toBe(true) // 03:00 is inside 22 to 07
    expect(isQuietAt(own, null, new Date('2026-03-02T12:00:00Z'))).toBe(false)
    // 03:00 UTC is 21:00 of the day before in San Salvador (UTC-6): outside 22 to 07 there
    expect(isQuietAt({ ...own, timezone: 'America/El_Salvador' }, null, at)).toBe(false)
  })
})
