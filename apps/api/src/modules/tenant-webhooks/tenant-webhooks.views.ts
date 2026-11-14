// What the settings page sees of a webhook: never its secret, which is shown once when it is made or renewed
export interface WebhookView {
  id: string
  url: string
  events: string[]
  status: string
  consecutiveFailures: number
  lastFailureAt: string | null
  createdAt: string
}

// The answer of the two calls that make a secret: the only time it leaves the platform
export interface WebhookWithSecretView extends WebhookView {
  secret: string
}

export interface WebhookDeliveryView {
  id: string
  event: string
  statusCode: number | null
  durationMs: number
  success: boolean
  error: string | null
  attempt: number
  createdAt: string
}

export interface WebhookDeliveryPage {
  items: WebhookDeliveryView[]
  nextCursor: string | null
}

export const WEBHOOK_SELECT = {
  id: true,
  url: true,
  events: true,
  status: true,
  consecutiveFailures: true,
  lastFailureAt: true,
  createdAt: true
} as const

export const DELIVERY_SELECT = {
  id: true,
  event: true,
  statusCode: true,
  durationMs: true,
  success: true,
  error: true,
  attempt: true,
  createdAt: true
} as const

interface WebhookRow {
  id: string
  url: string
  events: string[]
  status: string
  consecutiveFailures: number
  lastFailureAt: Date | null
  createdAt: Date
}

export function webhookView(row: WebhookRow): WebhookView {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  }
}

interface DeliveryRow extends Omit<WebhookDeliveryView, 'createdAt'> {
  createdAt: Date
}

export function deliveryView(row: DeliveryRow): WebhookDeliveryView {
  return { ...row, createdAt: row.createdAt.toISOString() }
}
