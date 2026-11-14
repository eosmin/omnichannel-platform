import { ApiKeyStatus, WebhookStatus } from '@platform/core/domain'

// The status columns are text: the values of the enums, read as text so that a status this page does not know (a newer
// server) can still be compared and drawn as it came
export const WEBHOOK_ACTIVE: string = WebhookStatus.ACTIVE
export const WEBHOOK_PAUSED: string = WebhookStatus.PAUSED
export const WEBHOOK_DISABLED: string = WebhookStatus.DISABLED
export const API_KEY_ACTIVE: string = ApiKeyStatus.ACTIVE

const WEBHOOK_STATUSES: readonly string[] = [WEBHOOK_ACTIVE, WEBHOOK_PAUSED, WEBHOOK_DISABLED]
const API_KEY_STATUSES: readonly string[] = Object.values(ApiKeyStatus)

// The status with a text of its own, or null for one that has none
export const knownWebhookStatus = (status: string): 'active' | 'paused' | 'disabled' | null =>
  WEBHOOK_STATUSES.includes(status) ? (status as 'active' | 'paused' | 'disabled') : null
export const knownApiKeyStatus = (status: string): 'active' | 'revoked' | 'expired' | null =>
  API_KEY_STATUSES.includes(status) ? (status as 'active' | 'revoked' | 'expired') : null
