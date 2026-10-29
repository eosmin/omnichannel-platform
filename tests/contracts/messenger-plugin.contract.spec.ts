import { MessengerPlugin } from '@platform/channels/messenger'
import { MessengerApi } from '@platform/core/domain'

import { testMetaMessagingContract } from './meta-messaging-plugin.contract'

testMetaMessagingContract({
  name: 'Messenger',
  create: meta => new MessengerPlugin(meta),
  webhookObject: MessengerApi.WEBHOOK_OBJECT,
  accountId: '109000000000001'
})
