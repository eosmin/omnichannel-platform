import { InstagramPlugin } from '@platform/channels/instagram'

import { testMetaMessagingContract } from './meta-messaging-plugin.contract'

testMetaMessagingContract({
  name: 'Instagram',
  create: meta => new InstagramPlugin(meta),
  webhookObject: 'instagram',
  accountId: '17841400000000001'
})
