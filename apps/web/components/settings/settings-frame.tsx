'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type MouseEvent, type ReactElement, type ReactNode, useRef, useState } from 'react'

import type { SettingsArea, SettingsEntry } from '../../lib/settings/entries'
import { UnsavedChangesContext } from '../../lib/settings/unsaved-changes'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

// The side navigation of a settings area next to its page. `entries` are already the ones the person
// may open; an area with none draws only the page, which says what it needs.
export function SettingsFrame({
  area,
  entries,
  backTo = null,
  children
}: {
  area: SettingsArea
  entries: readonly SettingsEntry[]
  // A way out of the area, first in the navigation (the account pages belong to no store)
  backTo?: { href: string; label: string } | null
  children: ReactNode
}): ReactElement {
  const t = useTranslations('settings.nav')
  const tUnsaved = useTranslations('settings.unsaved')
  const pathname = usePathname()
  const router = useRouter()
  const unsaved = useRef(0)
  const [leaving, setLeaving] = useState<string | null>(null)
  // A link of this navigation, while a form of the page holds changes, waits for the person's answer
  const guard = (event: MouseEvent, href: string): void => {
    if (unsaved.current === 0 || href === pathname) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    setLeaving(href)
  }
  // The keys are built from the area and the entry, and a spec checks every one exists
  type MessageKey = Parameters<typeof t>[0]
  const label = (key: string): string => t(`${area}.${key}` as MessageKey)
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 md:flex-row">
      {entries.length > 0 ? (
        <nav aria-label={label('label')} className="md:w-48 md:shrink-0">
          {backTo !== null && (
            <Link
              href={backTo.href}
              onClick={event => guard(event, backTo.href)}
              className="text-muted-foreground hover:bg-accent mb-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm"
            >
              <ArrowLeft aria-hidden className="size-4" />
              {backTo.label}
            </Link>
          )}
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
                    onClick={event => guard(event, entry.href)}
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
      <UnsavedChangesContext.Provider value={unsaved}>
        <div className="min-w-0 flex-1">{children}</div>
      </UnsavedChangesContext.Provider>
      <Dialog open={leaving !== null} onOpenChange={open => (open ? undefined : setLeaving(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tUnsaved('title')}</DialogTitle>
            <DialogDescription>{tUnsaved('body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setLeaving(null)}>
              {tUnsaved('stay')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const href = leaving
                setLeaving(null)
                if (href !== null) router.push(href)
              }}
            >
              {tUnsaved('leave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
