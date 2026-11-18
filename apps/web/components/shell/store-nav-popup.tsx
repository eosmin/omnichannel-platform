'use client'

import Link from 'next/link'
import type { ReactElement } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export interface NavEntry {
  href: string
  label: string
  isCurrent: boolean
}

// The links of the store on a phone, downloaded when the person reaches for the menu button (`StoreNav`)
export default function StoreNavPopup({
  entries,
  defaultOpen,
  trigger
}: {
  entries: readonly NavEntry[]
  defaultOpen: boolean
  trigger: ReactElement
}): ReactElement {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {entries.map(entry => (
          <DropdownMenuItem key={entry.href} asChild className="min-h-11">
            <Link
              href={entry.href}
              aria-current={entry.isCurrent ? 'page' : undefined}
              className={entry.isCurrent ? 'font-semibold' : undefined}
            >
              {entry.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
