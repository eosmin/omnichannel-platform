import { createHmac } from 'node:crypto'

import { MetaGraphClient } from '@platform/channels/meta'
import { channelEventSchema } from '@platform/plugins/runtime'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import {
  inboundText,
  MESSAGING_CUSTOMER,
  MESSAGING_TIMESTAMP,
  messagingWebhook
} from '../builders/meta-messaging-fixtures'

import { testChannelPluginContract } from './channel-plugin.contract'

const APP_SECRET = 'meta-messaging-contract-secret'

export interface MetaMessagingContract {
  name: string
  create: (meta: MetaGraphClient) => ChannelPlugin
  webhookObject: string
  accountId: string
}

// The send of the contract suite goes to Meta: the answer is a captured one
function stubMeta(): void {
  beforeEach(() => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            recipient_id: MESSAGING_CUSTOMER,
            message_id: 'mid.$cAAJdkrCd2ORnva8'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
  })
  afterEach(() => jest.restoreAllMocks())
}

// What Instagram and Messenger owe the SDK, and what the core does with their events: a message it
// refuses is a message lost, because Meta has been answered already and does not send it again
export function testMetaMessagingContract(contract: MetaMessagingContract): void {
  const { name, webhookObject, accountId } = contract
  const create = (): ChannelPlugin =>
    contract.create(
      new MetaGraphClient({ appSecret: APP_SECRET, verifyToken: 'verify', graphVersion: 'v23.0' })
    )
  const body = messagingWebhook(
    webhookObject,
    accountId,
    inboundText(accountId, 'Hola, ¿tienen talla 40?')
  )
  const rawBody = JSON.stringify(body)

  stubMeta()

  testChannelPluginContract(
    create,
    {
      inboundWebhook: {
        rawBody,
        headers: {
          'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`
        },
        body
      },
      emptyWebhook: messagingWebhook(webhookObject, accountId),
      invalidSignatureHeaders: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
      context: {
        storeId: '00000000-0000-4000-8000-000000000001',
        connectionId: accountId,
        credentials: { accessToken: 'EAAB-dummy-token' },
        metadata: {}
      },
      sendParams: {
        channelIdentity: MESSAGING_CUSTOMER,
        content: 'Hola, con gusto te ayudo',
        idempotencyKey: '00000000-0000-4000-8000-000000000002'
      }
    },
    { official: true }
  )

  describe(`${name} events against the schema of the core`, () => {
    const plugin = create()
    const event = (message: object): object =>
      messagingWebhook(webhookObject, accountId, {
        sender: { id: MESSAGING_CUSTOMER },
        recipient: { id: accountId },
        timestamp: MESSAGING_TIMESTAMP,
        message: { mid: 'mid.1', ...message }
      })

    it.each([
      ['a text', { text: 'hola' }],
      [
        'an album',
        {
          attachments: [1, 2, 3].map(n => ({
            type: 'image',
            payload: { url: `https://scontent.fbcdn.net/${n}.jpg` }
          }))
        }
      ],
      ['a type that is a key of Object', { attachments: [{ type: 'constructor', payload: {} }] }],
      ['a reply to a long id', { text: 'hi', reply_to: { mid: 'w'.repeat(400) } }],
      [
        'an ad with a long title',
        {
          text: 'hi',
          referral: { ad_id: '1', source: 'ADS', ads_context_data: { ad_title: 't'.repeat(900) } }
        }
      ]
    ])('accepts every event of %s', async (_name, message) => {
      const events = await plugin.handleWebhook(event(message))

      expect(events).toHaveLength(1)
      for (const each of events) expect(channelEventSchema.safeParse(each).success).toBe(true)
    })

    it('accepts a reaction and an echo', async () => {
      const events = await plugin.handleWebhook(
        messagingWebhook(
          webhookObject,
          accountId,
          {
            sender: { id: MESSAGING_CUSTOMER },
            recipient: { id: accountId },
            timestamp: MESSAGING_TIMESTAMP,
            reaction: { action: 'react', emoji: '❤️', reaction: 'love', mid: 'mid.1' }
          },
          {
            sender: { id: accountId },
            recipient: { id: MESSAGING_CUSTOMER },
            timestamp: MESSAGING_TIMESTAMP,
            message: { mid: 'mid.2', text: 'desde el celular', is_echo: true }
          }
        )
      )

      expect(events).toHaveLength(2)
      for (const each of events) expect(channelEventSchema.safeParse(each).success).toBe(true)
    })
  })
}
