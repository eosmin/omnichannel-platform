import { MessengerPlugin } from '@platform/channels/messenger'
import { MessengerApi, MetaWebhookApps } from '@platform/channels/meta'

import { testMetaMessagingContract } from './meta-messaging-plugin.contract'

testMetaMessagingContract({
  name: 'Messenger',
  create: meta => new MessengerPlugin(meta),
  webhookObject: MessengerApi.WEBHOOK_OBJECT,
  accountId: '109000000000001',
  webhookApp: MetaWebhookApps.MAIN
})
