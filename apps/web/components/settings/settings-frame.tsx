'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import type { SettingsArea, SettingsEntry } from '../../lib/settings/entries'
import { cn } from '../../lib/utils'

// The side navigation of a settings area next to its page. `entries` are already the ones the person
// may open; an area with none draws only the page, which says what it needs.
export function SettingsFrame({
  area,
  entries,
  children
}: {
  area: SettingsArea
  entries: readonly SettingsEntry[]
  children: ReactNode
}): ReactElement {
  const t = useTranslations('settings.nav')
  const pathname = usePathname()
  // The keys are built from the area and the entry, and a spec checks every one exists
  type MessageKey = Parameters<typeof t>[0]
  const label = (key: string): string => t(`${area}.${key}` as MessageKey)
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 md:flex-row">
      {entries.length > 0 ? (
        <nav aria-label={label('label')} className="md:w-48 md:shrink-0">
          <h2 className="text-muted-foreground mb-2 px-2 text-xs font-semibold uppercase">
            {label('title')}
          </h2>
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {entries.map(entry => {
              const isCurrent = pathname === entry.href || pathname.startsWith(`${entry.href}/`)
              return (
                <li key={entry.id}>
                  <Link
                    href={entry.href}
                    aria-current={isCurrent ? 'page' : undefined}
                    className={cn(
                      'hover:bg-accent block rounded-md px-2 py-1.5 text-sm whitespace-nowrap',
                      isCurrent ? 'bg-accent font-semibold' : 'text-muted-foreground'
                    )}
                  >
                    {label(entry.labelKey)}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
