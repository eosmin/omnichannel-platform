'use client'

import { useLocale } from 'next-intl'
import { useCallback } from 'react'

import { pluginNameOf } from './plugin-name'

type NamedByDescriptor = { displayName: { es: string; en: string } } | null | undefined

// The name a plugin shows in the interface: the one its descriptor declares in the language of the reader,
// else the name the server sent. No channel id decides it.
export function usePluginLabel(): (descriptor: NamedByDescriptor, serverName: string) => string {
  const locale = useLocale()
  return useCallback(
    (descriptor, serverName) => pluginNameOf(descriptor, locale, serverName),
    [locale]
  )
}
