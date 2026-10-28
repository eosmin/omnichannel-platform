import { MessengerPlugin } from '@platform/channels/messenger'

import { testMetaMessagingContract } from './meta-messaging-plugin.contract'

testMetaMessagingContract({
  name: 'Messenger',
  create: meta => new MessengerPlugin(meta),
  webhookObject: 'page',
  accountId: '109000000000001'
})
