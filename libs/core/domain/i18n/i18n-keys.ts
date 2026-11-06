import { ChannelConnectFieldKeys, ChannelSetupStepKeys } from '../channel-connect-constants'
import { ErrorCodes } from '../errors/error-codes'
import {
  type NotificationType,
  notificationMessageKey,
  NotificationTypes
} from '../notifications/notification-constants'
import { OrderCancellationReasons } from '../order-constants'
import { OrderReturnReasons } from '../shipping-constants'
import { ConversationStatusI18nKeys, OrderStatusI18nKeys } from '../status-enums'

// The reasons a notification can carry that have a sentence of their own (NOT-06, MED-11): the page,
// the email and the push draw `<message key>.reason.<CODE>`; any other reason keeps the plain text
export const NotificationFailureReasons = {
  [NotificationTypes.MESSAGE_FAILED]: [
    ErrorCodes.CHANNEL_WINDOW_EXPIRED,
    ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
    ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
    ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED,
    ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED,
    ErrorCodes.CHANNEL_NOT_CONNECTED,
    ErrorCodes.RATE_LIMIT_EXCEEDED
  ],
  [NotificationTypes.EXPORT_FAILED]: [ErrorCodes.EXPORT_TOO_LARGE, ErrorCodes.EXPORT_EMPTY]
} as const

// The message keys that the constants imply (TDD_09 §15.3): a new enum value, error code or
// notification type without a translation makes validate:translations fail. Sorted, so that the
// result is the same on every run.
export function generatedI18nKeys(): string[] {
  const keys = new Set<string>([
    ...Object.values(ConversationStatusI18nKeys),
    ...Object.values(OrderStatusI18nKeys),
    ...Object.values(OrderCancellationReasons),
    ...Object.values(OrderReturnReasons),
    ...Object.values(ChannelConnectFieldKeys),
    ...Object.values(ChannelSetupStepKeys),
    ...Object.values(ErrorCodes).map(code => `errors.${code}`),
    ...Object.values(NotificationTypes).flatMap(type => [
      `${notificationMessageKey(type)}.title`,
      `${notificationMessageKey(type)}.body`
    ]),
    ...Object.entries(NotificationFailureReasons).flatMap(([type, codes]) =>
      codes.map(code => `${notificationMessageKey(type as NotificationType)}.reason.${code}`)
    )
  ])
  return [...keys].sort()
}
