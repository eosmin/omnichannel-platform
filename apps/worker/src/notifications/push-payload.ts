import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { createTranslator } from '@platform/core/i18n-server'
import {
  clipPushText,
  type NotificationSeverityType,
  type NotificationType,
  PushLimits,
  type PushPayload,
  pushTag
} from '@platform/core/notifications'

export interface PushNotificationRow {
  id: string
  type: NotificationType
  severity: NotificationSeverityType
  messageKey: string
  params: unknown
  resourceId: string | null
  actionPath: string | null
}

// The locale of the person; the language of the product when it is one we have no catalog for
export function pushLocale(value: string): Locale {
  return SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE
}

// Only the text and numbers of the params fill the message: the column is JSON and crossed Redis
function messageParams(value: unknown): Record<string, string | number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const params: Record<string, string | number> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number') params[key] = item
  }
  return params
}

// What the service worker shows (TDD_06 §7.1). The text is written here, in the language of the
// person, because the worker has no catalog. A type with no message throws: it will not have one
// when it is tried again.
export function buildPushPayload(row: PushNotificationRow, locale: Locale): PushPayload {
  const t = createTranslator(locale, row.messageKey)
  const params = messageParams(row.params)
  return {
    notificationId: row.id,
    title: clipPushText(t('title', params), PushLimits.MAX_TITLE_LENGTH),
    body: clipPushText(t('body', params), PushLimits.MAX_BODY_LENGTH),
    tag: pushTag(row.type, row.resourceId, row.id),
    severity: row.severity,
    actionPath: row.actionPath
  }
}
