import { createHmac, timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import { DeliveryStatus, MessageType } from '@platform/core/domain'
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

function sign(rawBody: string): string {
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
    messagingWindow: { hours: 24, requiresTemplateWhenClosed: false },

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
      const expected = Buffer.from(sign(rawBody))
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
  return { ...base, ...overrides }
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
    headers: { 'x-signature': sign(inboundRaw) },
    body: inboundBody
  },
  emptyWebhook: { entries: [] },
  invalidSignatureHeaders: { 'x-signature': 'not-the-signature' },
  context,
  sendParams
}
