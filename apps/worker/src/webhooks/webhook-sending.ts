import { createHmac } from 'node:crypto'

import type { CredentialCipher } from '@platform/core/crypto'
import {
  WEBHOOK_USER_AGENT,
  WebhookDeliveryErrors,
  WebhookHeaders,
  WebhookLimits
} from '@platform/core/domain'
import { CORRELATION_ID_HEADER } from '@platform/core/logger'
import { UnsafeUrlError } from '@platform/core/url-safety'

import { type pinnedHttpsPost, WebhookPostFailed } from './pinned-https-post'

// What the two kinds of delivery of the worker have in common (the webhooks of a store and the webhooks of a plugin): how a
// delivery is signed and sent, how its secret is opened and how a failure is told apart. What each does with the result (which
// table it writes, what it turns off, whom it tells) is its own.

export const WebhookOutcome = {
  DELIVERED: 'delivered',
  SKIPPED: 'skipped', // The webhook is gone, or is not active any more: nothing to send, nothing to log
  FAILED_FOR_GOOD: 'failed_for_good' // This delivery will not be sent again; the next event is a new delivery
} as const
export type WebhookOutcome = (typeof WebhookOutcome)[keyof typeof WebhookOutcome]

export interface DeliveryDeps {
  post?: typeof pinnedHttpsPost
  // The tries BullMQ gives the job: the last failure is the one that counts
  maxAttempts?: number
  now?: () => number
}

export interface SignedDelivery {
  url: string
  secret: string
  event: string
  deliveryId: string
  payload: Record<string, unknown>
  // The header that carries the signature: the one of the platform unless the receiver asked for its own
  signatureHeader?: string
  correlationId?: string | undefined
  post: typeof pinnedHttpsPost
  now: () => number
}

// The body is `{ event, data, timestamp, deliveryId }`, the signature is `sha256=` and the hex HMAC of that exact text, and the
// post goes to the address checked now (pinnedHttpsPost). Resolves with the status of a 2xx answer.
export async function sendSigned(delivery: SignedDelivery): Promise<number> {
  const { url, secret, event, deliveryId, payload, post, now } = delivery
  const body = JSON.stringify({ event, data: payload, timestamp: now(), deliveryId })
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  return post(url, {
    body,
    timeoutMs: WebhookLimits.DELIVERY_TIMEOUT_MS,
    headers: {
      'content-type': 'application/json',
      'user-agent': WEBHOOK_USER_AGENT,
      [WebhookHeaders.EVENT]: event,
      [WebhookHeaders.DELIVERY]: deliveryId,
      ...(delivery.correlationId === undefined
        ? {}
        : { [CORRELATION_ID_HEADER]: delivery.correlationId }),
      // Last, so that nothing else sets the header the receiver verifies with (a manifest cannot name one of ours, and this holds
      // even for a stored one that predates the check)
      [delivery.signatureHeader ?? WebhookHeaders.SIGNATURE]: `sha256=${signature}`
    }
  })
}

// The sealed secret cannot be opened: no delivery can be signed until somebody makes a new one
export class UnreadableSecret extends Error {
  constructor() {
    super('the webhook secret is unreadable')
    this.name = 'UnreadableSecret'
  }
}

export function openSecret(cipher: CredentialCipher, sealed: Uint8Array): string {
  let secret: unknown
  try {
    secret = cipher.open(sealed)['secret']
  } catch {
    // A wrong key, damaged bytes or JSON that is not what was sealed: all of them are a secret nobody can read
    throw new UnreadableSecret()
  }
  if (typeof secret !== 'string' || secret === '') throw new UnreadableSecret()
  return secret
}

export interface Failure {
  status: number | null
  code: string
  retryable: boolean
}

export function failureOf(error: unknown): Failure {
  if (error instanceof WebhookPostFailed) {
    return { status: error.status, code: error.reason, retryable: error.retryable }
  }
  if (
    error instanceof UnreadableSecret ||
    (error instanceof Error && error.name === 'DecryptionError')
  ) {
    return { status: null, code: WebhookDeliveryErrors.SECRET_UNREADABLE, retryable: false }
  }
  // The address no longer leads to the public internet: sending it again will not change that
  if (error instanceof UnsafeUrlError) {
    return { status: null, code: WebhookDeliveryErrors.ADDRESS_NOT_ALLOWED, retryable: false }
  }
  return { status: null, code: WebhookDeliveryErrors.UNEXPECTED, retryable: true }
}

// Prisma's "record not found" and "foreign key failed": the row was deleted while its delivery was running
const GONE_CODES: ReadonlySet<string> = new Set(['P2025', 'P2003'])

export function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && GONE_CODES.has(code)
}
