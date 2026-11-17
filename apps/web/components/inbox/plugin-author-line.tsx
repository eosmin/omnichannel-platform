'use client'

import { Bot } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { isOnBehalfOfPerson, type PluginAuthorship } from '../../lib/inbox/plugin-author'
import { usePluginName } from '../../lib/inbox/use-plugin-name'

// The marks of a message a plugin wrote: the name it chose, "automatic" when no person is behind it, and "sent through" the
// plugin. All of it text of a plugin or of the platform, drawn as text.
export function PluginAuthorLine({
  authorship,
  fallbackName
}: {
  authorship: PluginAuthorship
  fallbackName: string
}): ReactElement {
  const t = useTranslations('inbox.thread')
  const plugin = usePluginName(authorship.pluginId)
  // A message the plugin wrote as a person: the person's name stays as the author, and the mark says the plugin wrote it for them
  if (isOnBehalfOfPerson(authorship)) {
    return (
      <span className="inline-flex max-w-full items-center gap-1" data-testid="plugin-on-behalf">
        <Bot aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate font-medium">
          {t('sentOnBehalf', { plugin, name: fallbackName })}
        </span>
      </span>
    )
  }
  return (
    <>
      <span className="max-w-48 truncate font-medium" title={authorship.nickname ?? undefined}>
        {authorship.nickname ?? fallbackName}
      </span>
      {authorship.automatic && authorship.nickname !== null ? (
        <span data-testid="plugin-automatic-mark">{t('automaticMark')}</span>
      ) : null}
      <span className="inline-flex items-center gap-1" data-testid="plugin-sent-through">
        <Bot aria-hidden className="size-3.5 shrink-0" />
        {t('sentThrough', { plugin })}
      </span>
    </>
  )
}

// "edited by" and "deleted by" a plugin: a component of their own, so a message no plugin touched asks the directory for nothing
export function PluginChangeLabel({
  pluginId,
  messageKey
}: {
  pluginId: string
  messageKey: 'editedByPlugin' | 'deletedByPlugin'
}): ReactElement {
  const t = useTranslations('inbox.thread')
  const plugin = usePluginName(pluginId)
  return <>{t(messageKey, { plugin })}</>
}
