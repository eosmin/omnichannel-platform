'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AvailableShortcuts, ListKeyAliases, Shortcuts } from '@platform/core/domain'

import { isMacPlatformName } from '../../lib/shortcuts/dispatch'
import { bindingKeys } from '../../lib/shortcuts/labels'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

type Group = keyof typeof AvailableShortcuts

const GROUPS: readonly Group[] = ['list', 'conversation', 'global']

// The arrows that do what j and k do are shown with them
const ALIASES: Partial<Record<string, string>> = {
  NEXT_CONVERSATION: ListKeyAliases.NEXT_CONVERSATION,
  PREVIOUS_CONVERSATION: ListKeyAliases.PREVIOUS_CONVERSATION
}

function Keys({ binding, isMac }: { binding: string; isMac: boolean }): ReactElement {
  const t = useTranslations('inbox.shortcuts')
  return (
    <span className="flex items-center gap-1">
      {bindingKeys(binding, isMac).map((step, at) => (
        <span key={`${at}-${step.join()}`} className="flex items-center gap-1">
          {at > 0 ? <span className="text-muted-foreground text-xs">{t('then')}</span> : null}
          {step.map(key => (
            <kbd
              key={key}
              className="bg-muted min-w-6 rounded border px-1.5 py-0.5 text-center font-mono text-xs"
            >
              {key}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

// The sheet of `?` (TDD_09 §9): the table of `libs/core/domain/shortcuts.ts`, the bindings that work today
export function ShortcutHelp({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const t = useTranslations('inbox.shortcuts')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {open ? <Body /> : null}
      </DialogContent>
    </Dialog>
  )
}

function Body(): ReactElement {
  const t = useTranslations('inbox.shortcuts')
  // The key is a group and a name of the table; a spec checks that every pair has its text
  const labelOf = useTranslations('inbox.shortcuts.labels') as unknown as (key: string) => string
  // Read when the sheet opens, in the browser: the table says Cmd or Ctrl by the platform
  const isMac = isMacPlatformName(navigator)
  return (
    <div className="grid gap-4">
      {GROUPS.map(group => (
        <section key={group} aria-labelledby={`shortcuts-${group}`} className="grid gap-2">
          <h3 id={`shortcuts-${group}`} className="text-sm font-semibold">
            {t(`groups.${group}`)}
          </h3>
          <dl className="grid gap-1.5">
            {AvailableShortcuts[group].map(name => {
              const table: Record<string, string> = Shortcuts[group]
              const binding = table[name]
              const alias = ALIASES[name]
              if (binding === undefined) return null
              return (
                <div key={name} className="flex items-center justify-between gap-4 text-sm">
                  <dt>{labelOf(`${group}.${name}`)}</dt>
                  <dd className="flex items-center gap-2">
                    <Keys binding={binding} isMac={isMac} />
                    {alias === undefined ? null : <Keys binding={alias} isMac={isMac} />}
                  </dd>
                </div>
              )
            })}
          </dl>
        </section>
      ))}
    </div>
  )
}
