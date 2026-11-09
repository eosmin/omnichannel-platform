import { createHmac, timingSafeEqual } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import {
  ChannelIconKeys,
  ChannelIdentityKinds,
  type ChannelLimits,
  DeliveryStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  ChannelCapability,
  type ChannelContext,
  type ChannelEvent,
  type ChannelHealth,
  type ChannelMessageResult,
  type ChannelPlugin,
  type ConnectInput,
  type ConnectResult,
  PluginError,
  PluginTypes,
  type SendMediaParams,
  type SendMessageParams
} from '@platform/plugins/sdk'

export const TOY_CHANNEL_ID = 'acme_chat'

const credentialsSchema = z.object({ apiKey: z.string().min(1).max(200) })

// A channel that a third party could have written: it names itself, draws itself and bounds its text only by
// what it declares below, and no file of the platform knows its id. It exists for the suites (the e2e shows the
// web draws it with no edit of the web) and is registered only when the environment says so, in a test one. It
// calls no provider: a message "sent" is an id made up on the spot.
@Injectable()
export class ToyChannelPlugin implements ChannelPlugin {
  readonly id = TOY_CHANNEL_ID
  readonly name = 'Acme Chat'
  readonly version = '1.0.0'
  readonly author = 'Acme'
  readonly type = PluginTypes.CHANNEL
  readonly displayName = { es: 'Acme Chat', en: 'Acme Chat' }
  readonly iconKey = ChannelIconKeys.MESSAGE_SQUARE
  readonly capabilities = [ChannelCapability.TEXT, ChannelCapability.REPLY_TO]
  readonly limits: ChannelLimits = { textMaxLength: 500 }
  readonly identityKind = ChannelIdentityKinds.OPAQUE
  readonly messagingWindow = null
  readonly receivesProviderWebhooks = true
  readonly connectFields = [
    {
      key: 'apiKey',
      label: { es: 'Clave de Acme', en: 'Acme API key' },
      secret: true,
      required: true,
      multiple: false
    }
  ]
  readonly imageHosts = { avatar: ['https://img.acme.test'], media: [] }

  connect(input: ConnectInput): Promise<ConnectResult> {
    const parsed = credentialsSchema.safeParse(input.credentials)
    if (!parsed.success) {
      return Promise.reject(
        new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
      )
    }
    // The account is named by a digest of the key, never by the key
    const digest = createHmac('sha256', 'acme-toy').update(parsed.data.apiKey).digest('hex')
    return Promise.resolve({
      connectionId: `acme-${digest.slice(0, 16)}`,
      displayName: 'Acme account',
      credentials: parsed.data,
      metadata: {}
    })
  }

  disconnect(): Promise<void> {
    return Promise.resolve()
  }

  healthCheck(): Promise<ChannelHealth> {
    return Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() })
  }

  sendMessage(_ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult> {
    return Promise.resolve({
      externalId: `acme-msg-${params.idempotencyKey}`,
      status: DeliveryStatus.SENT,
      sentAt: new Date().toISOString()
    })
  }

  sendMedia(_ctx: ChannelContext, _params: SendMediaParams): Promise<ChannelMessageResult> {
    return Promise.reject(
      new PluginError(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, { retryable: false })
    )
  }

  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    const given = headers['x-acme-signature']
    if (given === undefined) return false
    const expected = createHmac('sha256', 'acme-toy-webhook').update(rawBody).digest('hex')
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  handleWebhook(): Promise<ChannelEvent[]> {
    return Promise.resolve([])
  }
}
