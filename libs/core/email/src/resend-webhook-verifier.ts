import { Injectable, Logger } from '@nestjs/common'
import { Resend, type WebhookEventPayload } from 'resend'

import { unauthorized } from '@platform/core/errors'

export interface WebhookHeaders {
  id: string
  timestamp: string
  signature: string
}

// Verification is local (an HMAC of the raw body), so it needs no API key; the SDK only offers it on
// an instance, hence a placeholder key that is never sent anywhere.
const VERIFICATION_ONLY_KEY = 're_verification_only'

@Injectable()
export class ResendWebhookVerifier {
  private readonly resend = new Resend(VERIFICATION_ONLY_KEY)
  private readonly logger = new Logger(ResendWebhookVerifier.name)

  constructor(private readonly secret: string | undefined) {}

  // Throws a 401 PlatformException unless the body is signed with the webhook secret
  verify(rawBody: Buffer | undefined, headers: Partial<WebhookHeaders>): WebhookEventPayload {
    const { id, timestamp, signature } = headers
    if (rawBody === undefined || this.secret === undefined) {
      throw unauthorized('resend webhook not configured')
    }
    if (id === undefined || timestamp === undefined || signature === undefined) {
      throw unauthorized('missing webhook signature headers')
    }
    try {
      return this.resend.webhooks.verify({
        payload: rawBody.toString('utf8'),
        headers: { id, timestamp, signature },
        webhookSecret: this.secret
      })
    } catch (error) {
      // Fails closed, but says why: a wrong or malformed secret would otherwise turn every delivery
      // into a silent 401. The message names the cause ("timestamp too old", "no matching
      // signature"), never the secret or the body.
      this.logger.warn(
        `resend webhook refused: ${error instanceof Error ? error.message : 'unknown error'}`
      )
      throw unauthorized('invalid resend webhook signature')
    }
  }
}
