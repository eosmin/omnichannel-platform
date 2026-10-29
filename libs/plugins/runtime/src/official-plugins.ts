import type { Type } from '@nestjs/common'

import { InstagramPlugin } from '@platform/channels/instagram'
import { MessengerPlugin } from '@platform/channels/messenger'
import { MetaPlatformModule } from '@platform/channels/meta'
import { WebWidgetPlatformModule, WebWidgetPlugin } from '@platform/channels/web-widget'
import { WhatsAppPlugin } from '@platform/channels/whatsapp'
import type { CarrierPlugin, ChannelPlugin } from '@platform/plugins/sdk'

// The plugins that ship with the platform. Each channel or carrier library adds its class here
// when it is built (Steps 2.7, 2.8, 4.8 and 4.15).
export const OFFICIAL_CHANNEL_PLUGINS: readonly Type<ChannelPlugin>[] = [
  WhatsAppPlugin,
  InstagramPlugin,
  MessengerPlugin,
  WebWidgetPlugin
]

// What the official plugins are built from: the providers they inject
export const OFFICIAL_PLUGIN_IMPORTS: readonly Type<unknown>[] = [
  MetaPlatformModule,
  WebWidgetPlatformModule
]
export const OFFICIAL_CARRIER_PLUGINS: readonly Type<CarrierPlugin>[] = []
