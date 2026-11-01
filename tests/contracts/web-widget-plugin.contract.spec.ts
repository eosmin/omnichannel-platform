import { WebWidgetPlugin, signVisitorToken, widgetTokenKey } from '@platform/channels/web-widget'
import { WIDGET_TOKEN_HEADER } from '@platform/core/domain'
import type { StorageService } from '@platform/core/storage-module'
import { channelEventSchema } from '@platform/plugins/runtime'

import { testChannelPluginContract } from './channel-plugin.contract'

const tokenKey = widgetTokenKey('contract-secret-of-thirty-two-chars!')
const siteKey = 'pk_widget_AAAAAAAAAAAAAAAAAAAAAAAA'
const visitorId = '3f2c1a9e-4b7d-4c1e-9a55-0d1e2f3a4b5c'
const body = {
  visitorToken: signVisitorToken(tokenKey, { siteKey, visitorId }),
  clientMessageId: 'c1',
  content: 'Hola, tienen envios?'
}

// The token is what a signature is to a provider's webhook
testChannelPluginContract(
  () => new WebWidgetPlugin({ tokenKey }, {} as StorageService),
  {
    inboundWebhook: {
      rawBody: JSON.stringify(body),
      headers: { [WIDGET_TOKEN_HEADER]: body.visitorToken },
      body
    },
    emptyWebhook: {},
    invalidSignatureHeaders: { [WIDGET_TOKEN_HEADER]: 'x.y' },
    context: {
      storeId: '00000000-0000-4000-8000-000000000001',
      connectionId: siteKey,
      credentials: {},
      metadata: {}
    },
    sendParams: {
      channelIdentity: visitorId,
      content: 'Claro, enviamos a todo el pais',
      idempotencyKey: '00000000-0000-4000-8000-000000000002'
    }
  },
  { official: true }
)

// The core refuses an event that does not fit its schema, and a message refused is a message lost
describe('web widget events against the schema of the core', () => {
  it('fit', async () => {
    const events = await new WebWidgetPlugin({ tokenKey }, {} as StorageService).handleWebhook(body)
    expect(events).toHaveLength(1)
    for (const event of events) expect(channelEventSchema.safeParse(event).success).toBe(true)
  })
})
