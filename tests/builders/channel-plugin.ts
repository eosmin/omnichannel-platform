import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import { CapabilityOfMediaKind, ChannelMediaKinds } from '@platform/core/channel-media'
import { ChannelIdentityKinds, DeliveryStatus, MessageType } from '@platform/core/domain'
import {
  ChannelCapability,
  type ChannelContext,
  type ChannelEvent,
  ChannelEventTypes,
  type ChannelPlugin,
  PluginTypes,
  type SendMessageParams
} from '@platform/plugins/sdk'

export const TEST_CHANNEL_ID = 'test_channel'
const SECRET = 'test-channel-secret'

const webhookSchema = z.object({
  entries: z.array(
    z.object({
      to: z.string().min(1),
      from: z.string().min(1),
      id: z.string().min(1),
      text: z.string(),
      at: z.iso.datetime()
    })
  )
})

// The signature the test plugin accepts for a body
export function signTestChannelBody(rawBody: string): string {
  return createHmac('sha256', SECRET).update(rawBody).digest('hex')
}

// A channel plugin of the suite: it has a messaging window, signs its webhooks and calls no
// provider. The contract suite and the specs that need "a channel" use it.
export function buildChannelPlugin(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  const base: ChannelPlugin = {
    id: TEST_CHANNEL_ID,
    name: 'Test channel',
    version: '1.0.0',
    author: 'suite',
    type: PluginTypes.CHANNEL,
    capabilities: [
      ChannelCapability.TEXT,
      ChannelCapability.REPLY_TO,
      ChannelCapability.DELIVERY_RECEIPTS,
      ChannelCapability.MESSAGING_WINDOW
    ],
    limits: { textMaxLength: 4096 },
    identityKind: ChannelIdentityKinds.OPAQUE,
    messagingWindow: { hours: 24, requiresTemplateWhenClosed: false },
    connectFields: [
      {
        key: 'token',
        labelKey: 'settings.channels.connect.test_channel.token',
        secret: true,
        required: true,
        multiple: false
      }
    ],
    receivesProviderWebhooks: true,

    connect: input =>
      Promise.resolve({
        connectionId: 'test-connection',
        displayName: 'Test connection',
        credentials: input.credentials,
        metadata: {}
      }),
    disconnect: () => Promise.resolve(),
    healthCheck: () => Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() }),

    sendMessage: (_ctx, params) =>
      Promise.resolve({
        externalId: `ext-${params.idempotencyKey}`,
        status: DeliveryStatus.SENT,
        sentAt: new Date().toISOString()
      }),
    sendMedia: (_ctx, params) =>
      Promise.resolve({
        externalId: `ext-${params.idempotencyKey}`,
        status: DeliveryStatus.SENT,
        sentAt: new Date().toISOString()
      }),

    validateWebhookSignature: (rawBody, headers) => {
      const given = Buffer.from(headers['x-signature'] ?? '')
      const expected = Buffer.from(signTestChannelBody(rawBody))
      return given.length === expected.length && timingSafeEqual(given, expected)
    },
    handleWebhook: payload => {
      const parsed = webhookSchema.safeParse(payload)
      if (!parsed.success) return Promise.resolve([])
      return Promise.resolve(
        parsed.data.entries.map((entry): ChannelEvent => ({
          type: ChannelEventTypes.MESSAGE_RECEIVED,
          connectionId: entry.to,
          channelIdentity: entry.from,
          message: {
            externalId: entry.id,
            type: MessageType.TEXT,
            content: entry.text,
            timestamp: entry.at
          },
          timestamp: entry.at
        }))
      )
    }
  }
  const plugin = { ...base, ...overrides }
  // A kind of file as a capability needs its rule (the registry holds the plugin to it): the suite's channel
  // takes any type up to 10 MB unless a test says otherwise
  const kinds = Object.values(ChannelMediaKinds).filter(kind =>
    plugin.capabilities.includes(CapabilityOfMediaKind[kind])
  )
  return plugin.media !== undefined || kinds.length === 0
    ? plugin
    : {
        ...plugin,
        media: {
          maxFilesPerMessage: 1,
          kinds: Object.fromEntries(
            kinds.map(kind => [kind, { types: null, maxBytes: 10 * 1024 * 1024 }])
          )
        }
      }
}

const inboundBody = {
  entries: [
    {
      to: 'test-connection',
      from: '50322223333',
      id: 'wamid-1',
      text: 'hello',
      at: '2026-10-27T10:00:00.000Z'
    }
  ]
}
const inboundRaw = JSON.stringify(inboundBody)

const context: ChannelContext = {
  storeId: '00000000-0000-4000-8000-000000000001',
  connectionId: 'test-connection',
  credentials: { token: 'dummy' },
  metadata: {}
}

const sendParams: SendMessageParams = {
  channelIdentity: '50322223333',
  content: 'hi',
  idempotencyKey: '00000000-0000-4000-8000-000000000002'
}

export const testChannelFixtures = {
  inboundWebhook: {
    rawBody: inboundRaw,
    headers: { 'x-signature': signTestChannelBody(inboundRaw) },
    body: inboundBody
  },
  emptyWebhook: { entries: [] },
  invalidSignatureHeaders: { 'x-signature': 'not-the-signature' },
  context,
  sendParams
}
