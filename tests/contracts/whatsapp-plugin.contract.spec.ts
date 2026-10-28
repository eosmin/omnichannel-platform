import { createHmac } from 'node:crypto'

import { MetaGraphClient } from '@platform/channels/meta'
import { WhatsAppPlugin } from '@platform/channels/whatsapp'
import { channelEventSchema } from '@platform/plugins/runtime'

import {
  emptyWebhook,
  inboundTextWebhook,
  WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_CUSTOMER,
  WHATSAPP_PHONE_NUMBER_ID
} from '../builders/whatsapp-fixtures'

import { testChannelPluginContract } from './channel-plugin.contract'

const APP_SECRET = 'whatsapp-contract-secret'
const rawBody = JSON.stringify(inboundTextWebhook)

// The send of the contract suite goes to Meta: the answer is a captured one
beforeEach(() => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: WHATSAPP_CUSTOMER, wa_id: WHATSAPP_CUSTOMER }],
          messages: [{ id: 'wamid.HBgLMTU1NTUxMjM0NTY3FQIAERgSQ0E' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
  )
})
afterEach(() => jest.restoreAllMocks())

testChannelPluginContract(
  () =>
    new WhatsAppPlugin(
      new MetaGraphClient({ appSecret: APP_SECRET, verifyToken: 'verify', graphVersion: 'v23.0' })
    ),
  {
    inboundWebhook: {
      rawBody,
      headers: {
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`
      },
      body: inboundTextWebhook
    },
    emptyWebhook,
    invalidSignatureHeaders: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
    context: {
      storeId: '00000000-0000-4000-8000-000000000001',
      connectionId: WHATSAPP_PHONE_NUMBER_ID,
      credentials: {
        phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
        businessAccountId: WHATSAPP_BUSINESS_ACCOUNT_ID,
        accessToken: 'EAAB-dummy-token'
      },
      metadata: {}
    },
    sendParams: {
      channelIdentity: WHATSAPP_CUSTOMER,
      content: 'Hola, con gusto te ayudo',
      idempotencyKey: '00000000-0000-4000-8000-000000000002'
    }
  },
  { official: true }
)

// What the core does with the events of the plugin: a message it refuses is a message lost, because
// Meta has been answered already and does not send it again
describe('WhatsApp events against the schema of the core', () => {
  const plugin = new WhatsAppPlugin(
    new MetaGraphClient({ appSecret: APP_SECRET, verifyToken: 'verify', graphVersion: 'v23.0' })
  )
  const wrap = (message: object): object => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: WHATSAPP_PHONE_NUMBER_ID },
              contacts: [{ wa_id: WHATSAPP_CUSTOMER, profile: { name: 'n'.repeat(500) } }],
              messages: [
                { from: WHATSAPP_CUSTOMER, id: 'wamid.1', timestamp: '1761600000', ...message }
              ]
            }
          }
        ]
      }
    ]
  })

  it.each([
    ['a type it does not know', { type: 'order', order: {} }],
    ['a name of a type that is a key of Object', { type: 'constructor' }],
    ['a name of a type that is __proto__', { type: '__proto__' }],
    ['an interactive with no reply', { type: 'interactive', interactive: { type: 'nfm_reply' } }],
    [
      'a long file name and content type',
      {
        type: 'document',
        document: { id: '5', filename: 'f'.repeat(400), mime_type: 'x/'.padEnd(300, 'y') }
      }
    ],
    ['a long reply id', { type: 'text', text: { body: 'hi' }, context: { id: 'w'.repeat(400) } }]
  ])('accepts every event of %s', async (_name, message) => {
    const events = await plugin.handleWebhook(wrap(message))

    expect(events).toHaveLength(1)
    for (const event of events) expect(channelEventSchema.safeParse(event).success).toBe(true)
  })

  it('accepts a status whose error text is long', async () => {
    const events = await plugin.handleWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: WHATSAPP_PHONE_NUMBER_ID },
                statuses: [
                  {
                    id: 'wamid.9',
                    recipient_id: WHATSAPP_CUSTOMER,
                    status: 'failed',
                    timestamp: '1761600000',
                    errors: [{ code: 1, title: 't'.repeat(900) }]
                  }
                ]
              }
            }
          ]
        }
      ]
    })
    expect(events.map(event => channelEventSchema.safeParse(event).success)).toEqual([true])
  })
})
