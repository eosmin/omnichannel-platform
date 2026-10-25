import { ErrorCodes } from '../errors/error-codes'
import { notificationMessageKey, NotificationTypes } from '../notifications/notification-constants'
import { OrderCancellationReasons } from '../order-constants'
import { OrderReturnReasons } from '../shipping-constants'
import {
  ConversationStatus,
  ConversationStatusI18nKeys,
  OrderStatus,
  OrderStatusI18nKeys
} from '../status-enums'

import { generatedI18nKeys } from './i18n-keys'

describe('generatedI18nKeys', () => {
  const keys = generatedI18nKeys()

  it('has one key per status, error code, cancellation reason and notification part', () => {
    for (const status of Object.values(ConversationStatus)) {
      expect(keys).toContain(`conversations.status.${status}`)
    }
    for (const status of Object.values(OrderStatus))
      expect(keys).toContain(`orders.status.${status}`)
    for (const code of Object.values(ErrorCodes)) expect(keys).toContain(`errors.${code}`)
    for (const reason of Object.values(OrderCancellationReasons)) expect(keys).toContain(reason)
    for (const reason of Object.values(OrderReturnReasons)) expect(keys).toContain(reason)
    for (const type of Object.values(NotificationTypes)) {
      expect(keys).toContain(`notifications.${type}.title`)
      expect(keys).toContain(`notifications.${type}.body`)
    }
  })

  it('loses no key to a collision between two constants, and sorts them', () => {
    const generated = [
      ...Object.values(ConversationStatusI18nKeys),
      ...Object.values(OrderStatusI18nKeys),
      ...Object.values(OrderCancellationReasons),
      ...Object.values(OrderReturnReasons),
      ...Object.values(ErrorCodes).map(code => `errors.${code}`),
      ...Object.values(NotificationTypes).flatMap(type => [
        `${notificationMessageKey(type)}.title`,
        `${notificationMessageKey(type)}.body`
      ])
    ]
    expect(keys).toHaveLength(generated.length)
    expect(keys).toEqual([...keys].sort())
    for (const key of keys) {
      expect(key).toMatch(/^(conversations|orders|errors|notifications)\.[A-Za-z0-9_.]+$/)
    }
  })
})
