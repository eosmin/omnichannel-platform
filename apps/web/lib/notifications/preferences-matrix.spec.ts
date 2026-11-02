import type { TypePreferenceView } from '@platform/api-client'
import { NotificationTypes } from '@platform/core/notifications'

import { groupPreferences, hourLabel, timeZoneOptions } from './preferences-matrix'

const row = (type: string): TypePreferenceView => ({
  type,
  severity: 'info',
  inApp: true,
  push: false,
  email: false,
  sound: false
})

describe('groupPreferences', () => {
  it('keeps the order of the groups and leaves out types no group lists', () => {
    const groups = groupPreferences([
      row(NotificationTypes.EXPORT_READY),
      row(NotificationTypes.CONVERSATION_MENTIONED),
      row(NotificationTypes.CONVERSATION_ASSIGNED),
      row(NotificationTypes.DSR_MANUAL_REVIEW),
      row('future.thing')
    ])
    expect(groups.map(entry => entry.group)).toEqual(['conversations', 'system'])
    expect(groups[0]?.rows.map(entry => entry.type)).toEqual([
      NotificationTypes.CONVERSATION_ASSIGNED,
      NotificationTypes.CONVERSATION_MENTIONED
    ])
  })

  it('draws nothing for an empty answer', () => {
    expect(groupPreferences([])).toEqual([])
  })
})

describe('hourLabel', () => {
  it('pads to two digits', () => {
    expect(hourLabel(7)).toBe('07:00')
    expect(hourLabel(22)).toBe('22:00')
  })
})

describe('timeZoneOptions', () => {
  it('adds the current zone when the runtime does not list it', () => {
    expect(timeZoneOptions('Mars/Base', ['UTC'])).toEqual(['Mars/Base', 'UTC'])
    expect(timeZoneOptions('UTC', ['UTC'])).toEqual(['UTC'])
  })
})
