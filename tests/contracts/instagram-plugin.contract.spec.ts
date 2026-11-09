import { InstagramPlugin } from '@platform/channels/instagram'
import { InstagramApi, MetaWebhookApps } from '@platform/channels/meta'

import { testMetaMessagingContract } from './meta-messaging-plugin.contract'

testMetaMessagingContract({
  name: 'Instagram',
  create: meta => new InstagramPlugin(meta),
  webhookObject: InstagramApi.WEBHOOK_OBJECT,
  accountId: '17841400000000001',
  webhookApp: MetaWebhookApps.INSTAGRAM
})
