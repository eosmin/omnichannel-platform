'use client'

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { isOfficialChannelId } from '@platform/core/domain'

// The name a plugin shows in the interface. The server sends the name of the plugin in English; an
// official channel is named from the message files (the vocabulary: "Widget web"), any other keeps
// the name its author gave it.
export function usePluginLabel(): (pluginId: string, serverName: string) => string {
  const t = useTranslations('settings.routing.channelNames')
  return useCallback(
    (pluginId, serverName) => (isOfficialChannelId(pluginId) ? t(pluginId) : serverName),
    [t]
  )
}
