import { ErrorCodes } from '../errors/error-codes'
import { NotificationTypes } from '../notifications/notification-constants'
import { OrderCancellationReasons } from '../order-constants'
import { ConversationStatus, OrderStatus } from '../status-enums'

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
    for (const type of Object.values(NotificationTypes)) {
      expect(keys).toContain(`notifications.${type}.title`)
      expect(keys).toContain(`notifications.${type}.body`)
    }
  })

  it('has no key twice, in a stable order, and every key under a known namespace', () => {
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([...keys].sort())
    for (const key of keys) {
      expect(key).toMatch(/^(conversations|orders|errors|notifications)\.[A-Za-z0-9_.]+$/)
    }
  })
})
