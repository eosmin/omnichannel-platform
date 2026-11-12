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

  it('hides the switches of types nothing raises and the groups left empty', () => {
    const groups = groupPreferences([
      row(NotificationTypes.CONVERSATION_ASSIGNED),
      row(NotificationTypes.ORDER_PAYMENT_FAILED),
      row(NotificationTypes.REMITTANCE_OVERDUE),
      row(NotificationTypes.PLUGIN_ERROR),
      row(NotificationTypes.WEBHOOK_AUTO_DISABLED),
      row(NotificationTypes.CHANNEL_DISCONNECTED)
    ])
    expect(groups.map(entry => entry.group)).toEqual(['conversations', 'system'])
    expect(groups[1]?.rows.map(entry => entry.type)).toEqual([
      NotificationTypes.CHANNEL_DISCONNECTED
    ])
  })

  it('shows the switches of the order notices that the orders raise since Steps 4.3 and 4.9, and hides the one nothing raises', () => {
    const groups = groupPreferences([
      row(NotificationTypes.ORDER_CREATED),
      row(NotificationTypes.ORDER_STATUS_CHANGED),
      row(NotificationTypes.ORDER_PRICE_APPROVAL_REQUESTED),
      row(NotificationTypes.ORDER_PRICE_OVERRIDDEN),
      row(NotificationTypes.ORDER_PACKING_NOTE_CHANGED),
      row(NotificationTypes.ORDER_PAYMENT_FAILED),
      row(NotificationTypes.ORDER_MESSAGE_NOT_SENT)
    ])
    expect(groups.map(entry => entry.group)).toEqual(['orders'])
    expect(groups[0]?.rows.map(entry => entry.type)).toEqual([
      NotificationTypes.ORDER_CREATED,
      NotificationTypes.ORDER_STATUS_CHANGED,
      NotificationTypes.ORDER_MESSAGE_NOT_SENT,
      NotificationTypes.ORDER_PRICE_APPROVAL_REQUESTED,
      NotificationTypes.ORDER_PRICE_OVERRIDDEN,
      NotificationTypes.ORDER_PACKING_NOTE_CHANGED
    ])
  })

  it('shows the switches of the low stock warning, the dispatched transfer and the count awaiting apply, which the inventory raises since Steps 4.2, 4.5 and 4.6', () => {
    const groups = groupPreferences([
      row(NotificationTypes.INVENTORY_LOW),
      row(NotificationTypes.TRANSFER_DISPATCHED),
      row(NotificationTypes.COUNT_AWAITING_APPLY)
    ])
    expect(groups.map(entry => entry.group)).toEqual(['inventory'])
    expect(groups[0]?.rows.map(entry => entry.type)).toEqual([
      NotificationTypes.INVENTORY_LOW,
      NotificationTypes.TRANSFER_DISPATCHED,
      NotificationTypes.COUNT_AWAITING_APPLY
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
