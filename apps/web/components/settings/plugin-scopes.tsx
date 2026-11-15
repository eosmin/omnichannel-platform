'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

// The name of what a plugin may do, in the words of the store (`settings.plugins.scopes.<scope>`). A scope this page has no text for
// (the platform grew one) is shown as its own id, never hidden: the owner must see everything that is granted.
function useScopeLabel(): (scope: string) => string {
  const t = useTranslations('settings.plugins.scopes')
  return scope =>
    t.has(scope as Parameters<typeof t.has>[0]) ? t(scope as Parameters<typeof t>[0]) : scope
}

// The list of scopes of the consent screen and of the detail: the ones just asked for are marked
export function ScopeList({
  scopes,
  highlight = []
}: {
  scopes: readonly string[]
  highlight?: readonly string[]
}): ReactElement {
  const t = useTranslations('settings.plugins')
  const label = useScopeLabel()
  if (scopes.length === 0) return <p className="text-muted-foreground text-sm">{t('noScopes')}</p>
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {scopes.map(scope => (
        <li key={scope} className="flex flex-col">
          <span className="font-medium">
            {label(scope)}
            {highlight.includes(scope) ? (
              <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-normal">
                {t('newScope')}
              </span>
            ) : null}
          </span>
          <code className="text-muted-foreground font-mono text-xs break-all">{scope}</code>
        </li>
      ))}
    </ul>
  )
}
