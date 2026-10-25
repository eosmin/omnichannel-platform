import { ErrorCodes } from '../errors/error-codes'
import { notificationMessageKey, NotificationTypes } from '../notifications/notification-constants'
import { OrderCancellationReasons } from '../order-constants'
import { OrderReturnReasons } from '../shipping-constants'
import { ConversationStatusI18nKeys, OrderStatusI18nKeys } from '../status-enums'

// The message keys that the constants imply (TDD_09 §15.3): a new enum value, error code or
// notification type without a translation makes validate:translations fail. Sorted, so that the
// result is the same on every run.
export function generatedI18nKeys(): string[] {
  const keys = new Set<string>([
    ...Object.values(ConversationStatusI18nKeys),
    ...Object.values(OrderStatusI18nKeys),
    ...Object.values(OrderCancellationReasons),
    ...Object.values(OrderReturnReasons),
    ...Object.values(ErrorCodes).map(code => `errors.${code}`),
    ...Object.values(NotificationTypes).flatMap(type => [
      `${notificationMessageKey(type)}.title`,
      `${notificationMessageKey(type)}.body`
    ])
  ])
  return [...keys].sort()
}
