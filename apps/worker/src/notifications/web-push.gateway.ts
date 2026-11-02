import { Inject, Injectable } from '@nestjs/common'
import { sendNotification } from 'web-push'

import {
  isPushEndpoint,
  PushLimits,
  WEB_PUSH_CONFIG,
  type WebPushConfig
} from '@platform/core/notifications'

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

// The one place that talks to a push service. The VAPID keys go with each call, so no global state of
// the library is touched and a worker without keys simply has nothing to send with.
@Injectable()
export class WebPushGateway {
  constructor(@Inject(WEB_PUSH_CONFIG) private readonly config: WebPushConfig) {}

  get enabled(): boolean {
    return this.config.vapid !== null
  }

  async send(target: PushTarget, body: string, urgent: boolean): Promise<void> {
    const { vapid } = this.config
    if (vapid === null) return
    // The list is checked again where the request leaves: a row older than the rule is not trusted
    if (!isPushEndpoint(target.endpoint)) throw new Error('the endpoint is not a push service')
    await sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      body,
      {
        TTL: PushLimits.TTL_SECONDS,
        timeout: PushLimits.REQUEST_TIMEOUT_MS,
        urgency: urgent ? 'high' : 'normal',
        vapidDetails: vapid
      }
    )
  }
}
