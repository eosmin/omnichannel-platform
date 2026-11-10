import type { Type } from '@nestjs/common'

import { InstagramPlugin } from '@platform/channels/instagram'
import { MessengerPlugin } from '@platform/channels/messenger'
import { MetaPlatformModule } from '@platform/channels/meta'
import { WebWidgetPlatformModule, WebWidgetPlugin } from '@platform/channels/web-widget'
import { WhatsAppPlugin } from '@platform/channels/whatsapp'
import { declaredRedactedKeys } from '@platform/core/domain'
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

// The names of secret fields that plugin classes declare (`static redactedKeys`), each list checked and the
// lists joined without repeats. A class that declares none adds none; a bad declaration throws, so the boot fails.
export function redactedKeysOf(
  classes: readonly (Type<ChannelPlugin> & { redactedKeys?: unknown })[]
): readonly string[] {
  const names = new Set<string>()
  for (const cls of classes) {
    for (const name of declaredRedactedKeys(cls.redactedKeys)) names.add(name)
  }
  return Object.freeze([...names])
}

// What the apps pass to the logger of the platform: the log hides these besides the names the core knows. It is
// read from the classes and not from the registry, because the logger exists before the registry does.
export function officialRedactedKeys(): readonly string[] {
  return redactedKeysOf(OFFICIAL_CHANNEL_PLUGINS)
}
